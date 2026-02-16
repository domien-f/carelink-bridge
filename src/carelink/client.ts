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

  private async fetchAsCarepartner(_role: string): Promise<CareLinkData> {
    let patientId = this.options.patientId;

    if (!patientId) {
      const patientsResp = await this.axiosInstance.get<CareLinkPatientLink[]>(this.urls.linkedPatients);
      if (patientsResp.data?.length > 0) {
        patientId = patientsResp.data[0].username;
        logger.log('Using linked patient:', patientId);
      } else {
        throw new Error('No linked patients found for care partner account');
      }
    }

    // Check if patient has a BLE device by fetching monitor data first
    try {
      const monitorResp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);
      if (monitorResp.data && this.isBleDevice(monitorResp.data.medicalDeviceFamily)) {
        logger.log('BLE device detected for carepartner, using BLE endpoint');
        return this.fetchBleDeviceData(patientId, 'carepartner');
      }
    } catch {
      // Fall through to standard carepartner flow
    }

    // Standard carepartner flow: BLE endpoint with multi-version fallback
    logger.log('Fetching country settings from:', this.urls.countrySettings);
    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const dataRetrievalUrl = settingsResp.data?.blePereodicDataEndpoint;

    if (!dataRetrievalUrl) {
      throw new Error('Unable to retrieve data retrieval URL for care partner account');
    }

    logger.log('Data retrieval URL:', dataRetrievalUrl);

    // Try multiple API versions
    const endpoints = [
      dataRetrievalUrl,
      dataRetrievalUrl.replace('/v6/', '/v5/'),
      dataRetrievalUrl.replace('/v6/', '/v11/'),
      dataRetrievalUrl.replace('/v5/', '/v6/'),
      dataRetrievalUrl.replace('/v5/', '/v11/'),
    ];

    const body: Record<string, string> = {
      username: this.options.username,
      role: 'carepartner',
      patientId,
    };

    for (const endpoint of endpoints) {
      try {
        logger.log('Trying carepartner endpoint:', endpoint);
        const resp = await this.axiosInstance.post<CareLinkData>(endpoint, body, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.status === 200) {
          logger.log('GET data (as carepartner)', endpoint);
          return resp.data;
        }
      } catch {
        logger.log('Endpoint failed:', endpoint);
      }
    }

    throw new Error('All carepartner data endpoints failed');
  }

  private isBleDevice(deviceFamily: string | undefined): boolean {
    if (!deviceFamily) return false;
    return deviceFamily.includes('BLE') || deviceFamily.includes('SIMPLERA');
  }

  private async fetchBleDeviceData(patientId?: string, role: string = 'patient'): Promise<CareLinkData> {
    logger.log('Fetching BLE device data');

    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const bleEndpoint = settingsResp.data?.blePereodicDataEndpoint;

    if (!bleEndpoint) {
      throw new Error('No BLE endpoint found in country settings');
    }

    if (!patientId) {
      const userResp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
      patientId = userResp.data?.id;
    }

    const body: Record<string, string> = {
      username: this.options.username,
      role,
    };

    if (patientId) {
      body.patientId = patientId;
    }

    const resp = await this.axiosInstance.post<CareLinkData>(bleEndpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    if (resp.data && resp.status === 200) {
      logger.log('GET data (BLE)', bleEndpoint);
      return resp.data;
    }

    throw new Error('BLE endpoint returned empty data');
  }

  private async fetchAsPatient(): Promise<CareLinkData> {
    // Try the monitor endpoint first (works for 7xxG pumps)
    try {
      const resp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);

      if (resp.data && this.isBleDevice(resp.data.medicalDeviceFamily)) {
        logger.log('BLE device detected, using BLE endpoint');
        return this.fetchBleDeviceData();
      }

      if (resp.status === 200 && resp.data && Object.keys(resp.data).length > 1) {
        logger.log('GET data', this.urls.monitorData);
        return resp.data;
      }
    } catch {
      // Fall through to legacy endpoint
    }

    // Fall back to legacy connect endpoint
    const url = this.urls.connectData(Date.now());
    const resp = await this.axiosInstance.get<CareLinkData>(url);
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
