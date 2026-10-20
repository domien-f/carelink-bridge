import { describe, it, expect } from 'vitest';
import { payloadAgeMinutes, isPayloadFresh, fresherPayload } from '../src/carelink/client.js';

const NOW = 1_760_000_000_000;
const minutesAgo = (m: number) => NOW - m * 60 * 1000;

describe('payloadAgeMinutes()', () => {
  it('computes age from the payload own server clock', () => {
    expect(
      payloadAgeMinutes({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(33),
      }),
    ).toBeCloseTo(33, 5);
  });

  it('returns undefined when the payload carries no usable timestamps', () => {
    expect(payloadAgeMinutes({})).toBeUndefined();
    expect(payloadAgeMinutes({ currentServerTime: NOW })).toBeUndefined();
    expect(payloadAgeMinutes(undefined)).toBeUndefined();
    expect(
      payloadAgeMinutes({
        currentServerTime: Number.NaN,
        lastMedicalDeviceDataUpdateServerTime: NOW,
      }),
    ).toBeUndefined();
  });
});

describe('isPayloadFresh()', () => {
  it('accepts data inside and exactly at the threshold', () => {
    expect(
      isPayloadFresh({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(19),
      }),
    ).toBe(true);
    expect(
      isPayloadFresh({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(20),
      }),
    ).toBe(true);
  });

  it('rejects a payload frozen for weeks', () => {
    expect(
      isPayloadFresh({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(47510.42),
      }),
    ).toBe(false);
  });

  it('treats an undatable payload as fresh rather than discarding real readings', () => {
    expect(isPayloadFresh({})).toBe(true);
    expect(isPayloadFresh(undefined)).toBe(true);
  });
});

describe('fresherPayload()', () => {
  const old = {
    currentServerTime: NOW,
    lastMedicalDeviceDataUpdateServerTime: minutesAgo(47510),
  };
  const recent = {
    currentServerTime: NOW,
    lastMedicalDeviceDataUpdateServerTime: minutesAgo(2),
  };

  it('keeps the more recent of two datable payloads', () => {
    expect(fresherPayload(old, recent)).toBe(recent);
    expect(fresherPayload(recent, old)).toBe(recent);
  });

  it('never lets an undatable payload displace a datable one', () => {
    const undatable = { foo: 'bar' };
    expect(fresherPayload(old, undatable)).toBe(old);
    expect(fresherPayload(undatable, recent)).toBe(recent);
  });

  it('handles an absent side', () => {
    expect(fresherPayload(undefined, old)).toBe(old);
    expect(fresherPayload(old, undefined)).toBe(old);
    expect(fresherPayload(undefined, undefined)).toBeUndefined();
  });
});