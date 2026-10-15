import { describe, expect, it } from 'vitest';
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_SECONDS,
  clientNetwork,
  judgeAttempt,
  loginThrottleKey,
} from './loginThrottle';

describe('clientNetwork', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(clientNetwork('203.0.113.7')).toBe('203.0.113.7');
    expect(clientNetwork(' 203.0.113.7 ')).toBe('203.0.113.7');
  });

  // One subscriber holds a whole /64: counting per address would hand a
  // guesser 2^64 budgets.
  it('counts an IPv6 address by its /64, however it is written', () => {
    const network = '2001:db8:85a3:8d3::/64';
    expect(clientNetwork('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe(network);
    expect(clientNetwork('2001:0DB8:85A3:08D3:0000:0000:0000:0001')).toBe(network);
    expect(clientNetwork('2001:db8:85a3:8d3::1')).toBe(network);
    expect(clientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientNetwork('::1')).toBe('0:0:0:0::/64');
  });

  it('reads an IPv4 address written in IPv6 form as the IPv4 it carries', () => {
    expect(clientNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('names a request without a client address', () => {
    expect(clientNetwork(null)).toBe('unknown-client');
    expect(clientNetwork('')).toBe('unknown-client');
  });
});

describe('loginThrottleKey', () => {
  it('is a keyed hash of the network, never the address', async () => {
    const key = await loginThrottleKey('secret', '203.0.113.7');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain('203');
    expect(await loginThrottleKey('secret', '203.0.113.7')).toBe(key);
    expect(await loginThrottleKey('another secret', '203.0.113.7')).not.toBe(key);
    expect(await loginThrottleKey('secret', '203.0.113.8')).not.toBe(key);
  });

  it('gives one key to every address of a /64', async () => {
    expect(await loginThrottleKey('secret', '2001:db8:1:2::a')).toBe(
      await loginThrottleKey('secret', '2001:db8:1:2:ffff::b'),
    );
  });
});

describe('judgeAttempt', () => {
  const start = 1_800_000_000;

  it('lets the limit through, and refuses the one after it until the window ends', () => {
    expect(judgeAttempt(LOGIN_ATTEMPT_LIMIT, start, start + 10).allowed).toBe(true);
    const refused = judgeAttempt(LOGIN_ATTEMPT_LIMIT + 1, start, start + 10);
    expect(refused).toEqual({ allowed: false, retryAfter: LOGIN_WINDOW_SECONDS - 10 });
  });

  it('never tells a client to come back in zero seconds', () => {
    expect(judgeAttempt(LOGIN_ATTEMPT_LIMIT + 1, start, start + LOGIN_WINDOW_SECONDS).retryAfter).toBe(1);
  });
});
