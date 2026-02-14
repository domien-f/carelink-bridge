import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import * as logger from '../logger.js';
import { loadLoginData, saveLoginData, isTokenExpired, refreshToken } from './token.js';
import { loadProxyList, createProxyAgent, ProxyRotator } from './proxy.js';
import { resolveServerName, buildUrls, type CareLinkUrls } from './urls.js';
import type { CareLinkData, CareLinkUserInfo, CareLinkPatientLink, CareLinkCountrySettings } from '../types/carelink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REQUESTS_PER_FETCH = 30;
const DEFAULT_MAX_RETRY_DURATION = 512;

export interface CareLinkClientOptions {
  username: string;
  password: string;
  server?: string;
  serverName?: string;
  countryCode?: string;
  lang?: string;
  patientId?: string;
  maxRetryDuration?: number;
}

export class CareLinkClient {
  private axiosInstance: AxiosInstance;
  private proxyRotator: ProxyRotator;
  private urls: CareLinkUrls;
  private loginDataPath: string;
  private serverName: string;
  private options: CareLinkClientOptions;
  private requestCount = 0;

  constructor(options: CareLinkClientOptions) {
    this.options = options;

    const countryCode = options.countryCode || process.env['MMCONNECT_COUNTRYCODE'] || 'gb';
    const lang = options.lang || process.env['MMCONNECT_LANGCODE'] || 'en';

    this.serverName = resolveServerName(
      options.server || process.env['MMCONNECT_SERVER'],
      options.serverName || process.env['MMCONNECT_SERVERNAME'],
    );
    this.urls = buildUrls(this.serverName, countryCode, lang);
    this.loginDataPath = path.join(__dirname, '..', '..', 'logindata.json');

    // Load proxy list
    const useProxy = (process.env['USE_PROXY'] || 'true').toLowerCase() !== 'false';
    const proxyFile = path.join(__dirname, '..', '..', 'https.txt');
    const proxies = useProxy ? loadProxyList(proxyFile) : [];
    this.proxyRotator = new ProxyRotator(proxies);

    // Set up axios
    this.axiosInstance = axios.create({
      maxRedirects: 0,
      timeout: 15_000,
    });

    // Response interceptor: treat 2xx/3xx as success
    this.axiosInstance.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status >= 200 && error.response?.status < 400) {
          return error.response;
        }
        return Promise.reject(error);
      },
    );

    // Request interceptor: count requests and set headers
    this.axiosInstance.interceptors.request.use(config => {
      this.requestCount++;
      if (this.requestCount > MAX_REQUESTS_PER_FETCH) {
        throw new Error('Request count exceeds the maximum in one fetch!');
      }

      config.headers['User-Agent'] = USER_AGENT;
      config.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
      config.headers['Accept-Language'] = 'en-US,en;q=0.9';
      config.headers['Accept-Encoding'] = 'gzip, deflate';
      config.headers['Connection'] = 'keep-alive';
      return config;
    });

    // Apply first proxy
    if (this.proxyRotator.hasProxies) {
      this.applyProxy(this.proxyRotator.getNext());
    }
  }

  private applyProxy(proxy: { ip: string; port: string; username?: string; password?: string; protocols: string[] } | null): void {
    if (proxy) {
      const agent = createProxyAgent(proxy);
      if (agent) {
        this.axiosInstance.defaults.httpsAgent = agent;
        this.axiosInstance.defaults.httpAgent = agent;
        console.log(`[Proxy] Using proxy: ${proxy.ip}:${proxy.port}${proxy.username ? ' (authenticated)' : ''}`);
      }
    } else {
      this.axiosInstance.defaults.httpsAgent = undefined;
      this.axiosInstance.defaults.httpAgent = undefined;
    }
  }

  private async authenticate(): Promise<void> {
    let loginData = loadLoginData(this.loginDataPath);
    if (!loginData) {
      throw new Error(
        'No logindata.json found. Run "npm run login" first to authenticate with CareLink.',
      );
    }

    if (isTokenExpired(loginData.access_token)) {
      try {
        loginData = await refreshToken(loginData);
        saveLoginData(this.loginDataPath, loginData);
      } catch (e) {
        // Delete stale logindata so next startup triggers re-login
        try { fs.unlinkSync(this.loginDataPath); } catch { /* ignore */ }
        console.error('[Token] Deleted logindata.json — run "npm run login" to re-authenticate.');
        throw new Error('Refresh token expired. Run "npm run login" to log in again.');
      }
    }

    this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
    console.log('[Token] Using token-based auth from logindata.json');
  }

  private async getCurrentRole(): Promise<string> {
    const resp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
    return resp.data?.role?.toUpperCase() ?? '';
  }

  private async getConnectData(): Promise<CareLinkData> {
    const role = await this.getCurrentRole();
    logger.log('getConnectData - currentRole:', role);

    if (role === 'CARE_PARTNER_OUS' || role === 'CARE_PARTNER') {
      return this.fetchAsCarepartner(role);
    }
    return this.fetchAsPatient();
  }

  private async fetchAsCarepartner(role: string): Promise<CareLinkData> {
    const resp = await this.axiosInstance.get<CareLinkPatientLink[]>(this.urls.linkedPatients);
    const patients = resp.data;

    if (!patients || patients.length === 0) {
      throw new Error('No linked patients found for this carepartner account');
    }

    console.log(`Found ${patients.length} linked patient(s)`);
    const patient = patients[0];
    console.log(`Fetching data for patient: ${patient.username}`);
    
    const url = this.urls.connectData(Date.now());
    const dataResp = await this.axiosInstance.get<CareLinkData>(url, {
      params: {
        username: patient.username,
        role: 'carepartner',
      },
    });

    logger.log('GET data', url);
    return dataResp.data;
  }

  private async fetchBleDeviceData(): Promise<CareLinkData> {
    console.log('[BLE] Fetching BLE device data');
    
    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const bleEndpoint = settingsResp.data?.blePereodicDataEndpoint;
    
    if (!bleEndpoint) {
      throw new Error('No BLE endpoint found in country settings');
    }
    
    const userResp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
    const patientId = userResp.data?.id;
    
    const body: any = {
      username: this.options.username,
      role: 'patient',
      appVersion: 'CareLink Connect 2.0'
    };
    
    if (patientId) {
      body.patientId = patientId;
    }
    
    try {
      const resp = await this.axiosInstance.post<any>(bleEndpoint, body, {
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
        },
      });
      
      if (resp.data && resp.status === 200) {
        console.log('[BLE] Successfully got data from BLE endpoint');
        logger.log('GET data', bleEndpoint);
        return resp.data;
      }
      
      throw new Error('BLE endpoint returned empty data');
    } catch (e: any) {
      throw e;
    }
  }

  private async fetchAsPatient(): Promise<CareLinkData> {
    try {
      const resp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);
      
      if (resp.data && (resp.data as any).deviceFamily) {
        const deviceFamily = (resp.data as any).deviceFamily;
        
        const isBleDevice = deviceFamily && (
          deviceFamily.includes('BLE') || 
          deviceFamily.includes('MINIMED') || 
          deviceFamily.includes('SIMPLERA')
        );
        
        if (isBleDevice) {
          console.log('[BLE] BLE device detected, fetching from BLE endpoint');
          return this.fetchBleDeviceData();
        }
      }
      
      if (resp.status === 200 && resp.data && Object.keys(resp.data).length > 1) {
        logger.log('GET data', this.urls.monitorData);
        return resp.data;
      }
    } catch (e: any) {
      // Fall through to legacy endpoint
    }

    const url = this.urls.connectData(Date.now());
    const resp = await this.axiosInstance.get<CareLinkData>(url);
    
    if (resp.status === 204 || !resp.data || Object.keys(resp.data).length === 0) {
      console.log('[Patient] WARNING: Connect endpoint returned no content (HTTP ' + resp.status + ')');
      console.log('[Patient] This may indicate the device has not uploaded data recently or requires a different endpoint');
    }
    
    logger.log('GET data', url);
    return resp.data;
  }

  async fetch(): Promise<CareLinkData> {
    this.requestCount = 0;
    this.proxyRotator.resetRetries();

    const maxRetry = this.proxyRotator.hasProxies ? 10 : 1;
    console.log('[Fetch] Starting fetch, max retries:', maxRetry);

    for (let i = 1; i <= maxRetry; i++) {
      try {
        this.requestCount = 0;
        await this.authenticate();
        const data = await this.getConnectData();
        console.log('[Fetch] Success!');
        return data;
      } catch (e: unknown) {
        const err = e as { response?: { status: number }; code?: string; cause?: { code?: string }; message?: string };
        const httpStatus = err.response?.status;
        const errorCode = err.code || err.cause?.code || '';
        const isProxyError = [400, 403, 407, 502, 503].includes(httpStatus ?? 0);
        const isNetworkError = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EPROTO', 'ERR_SOCKET_BAD_PORT'].includes(errorCode);

        console.log(`[Fetch] Attempt ${i} failed: ${httpStatus ? 'HTTP ' + httpStatus : errorCode || (err as Error).message}`);

        if ((isProxyError || isNetworkError) && this.proxyRotator.hasProxies) {
          console.log('[Fetch] Trying next proxy...');
          const nextProxy = this.proxyRotator.tryNext();
          if (!nextProxy) throw e;
          this.applyProxy(nextProxy);
          await sleep(1000);
          continue;
        }

        if (i === maxRetry) throw e;

        const timeout = Math.pow(2, i);
        await sleep(1000 * timeout);
      }
    }

    throw new Error('Fetch failed after all retries');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
