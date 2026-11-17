import { timingSafeEqual } from 'node:crypto';

export function authorizedAgentCallback(authorization: string | undefined) {
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!token || !authorization) return false;
  const expected = Buffer.from('Bearer ' + token);
  const header = Buffer.from(authorization);
  return header.length === expected.length && timingSafeEqual(header, expected);
}
