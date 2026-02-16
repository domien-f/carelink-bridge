import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', 'my.env') });
dotenv.config();

import { loadConfig } from './config.js';
import { CareLinkClient } from './carelink/client.js';
import { transform } from './transform/index.js';
import { makeRecencyFilter } from './filter.js';
import { upload } from './nightscout/upload.js';
import * as logger from './logger.js';
import { login, LOGINDATA_FILE } from './login.js';
import type { NightscoutSGVEntry, NightscoutDeviceStatus } from './types/nightscout.js';

const config = loadConfig();
logger.setVerbose(config.verbose);

const client = new CareLinkClient({
  username: config.username,
  password: config.password,
  maxRetryDuration: config.maxRetryDuration,
  patientId: config.patientId,
  countryCode: config.countryCode,
  lang: config.language,
});

const baseUrl = config.nsBaseUrl || ('https://' + config.nsHost);
const entriesUrl = baseUrl + '/api/v1/entries.json';
const devicestatusUrl = baseUrl + '/api/v1/devicestatus.json';

const filterSgvs = makeRecencyFilter<NightscoutSGVEntry>(item => item.date);
const filterDeviceStatus = makeRecencyFilter<NightscoutDeviceStatus>(
  item => new Date(item.created_at).getTime(),
);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadIfNew(items: unknown[], endpoint: string): Promise<void> {
  if (items.length === 0) {
    logger.log('No new items for', endpoint);
    return;
  }
  try {
    await upload(items, endpoint, config.nsSecret);
  } catch (err) {
    // Continue even if Nightscout can't be reached
    console.error(err);
  }
}

async function requestLoop(): Promise<void> {
  while (true) {
    try {
      const data = await client.fetch();

      if (!data?.lastMedicalDeviceDataUpdateServerTime) {
        console.log('[Bridge] Warning: received empty or invalid data from CareLink');
        console.log('[Bridge] Data keys:', Object.keys(data || {}));
      } else {
        const transformed = transform(data, config.sgvLimit);
        const newSgvs = filterSgvs(transformed.entries);
        const newDeviceStatuses = filterDeviceStatus(transformed.devicestatus);

        logger.log(
          `Next check in ${Math.round(config.interval / 1000)}s` +
          ` (at ${new Date(Date.now() + config.interval)})`,
        );

        await uploadIfNew(newSgvs, entriesUrl);
        await uploadIfNew(newDeviceStatuses, devicestatusUrl);
      }
    } catch (error) {
      console.error(error);
    }

    await sleep(config.interval);
  }
}

async function ensureLogin(): Promise<void> {
  if (!fs.existsSync(LOGINDATA_FILE)) {
    console.log('[Bridge] No logindata.json found — starting login flow...');
    const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
    await login(isUS, config.username, config.password);
    console.log('');
  }
}

// Start
try {
  await ensureLogin();
  console.log(`[Bridge] Starting — interval set to ${config.interval / 1000}s`);
  console.log('[Bridge] Fetching data now...');
  await requestLoop();
} catch (err) {
  console.error('[Bridge] Fatal:', (err as Error).message);
  process.exit(1);
}
