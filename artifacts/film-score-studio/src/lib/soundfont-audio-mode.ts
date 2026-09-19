/**
 * Replit's development preview Chromium can expose AudioWorklet while leaving
 * addModule() pending indefinitely. Published hosts still try the worklet.
 */
export function shouldStartWithCompatibilityAudio(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.replit.dev');
}