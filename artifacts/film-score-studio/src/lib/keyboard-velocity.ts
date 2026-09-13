const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Convert a pointer location into MIDI velocity. iPadOS commonly reports
 * pressure 0.5 for every finger touch, so that placeholder is intentionally
 * ignored in favor of the key's vertical position.
 */
export function getTouchVelocity({
  clientY,
  boundsTop,
  boundsHeight,
  pressure,
  pointerType,
}: {
  clientY: number;
  boundsTop: number;
  boundsHeight: number;
  pressure: number;
  pointerType: string;
}) {
  const positionVelocity = 28 + clamp((clientY - boundsTop) / Math.max(1, boundsHeight), 0, 1) * 99;
  const hasGenuinePressure =
    pressure > 0.01 &&
    pressure < 0.99 &&
    pressure !== 0.5 &&
    (pointerType === 'pen' || pointerType === 'touch');
  const velocity = hasGenuinePressure
    ? positionVelocity * 0.7 + (pressure * 127) * 0.3
    : positionVelocity;
  return Math.round(clamp(velocity, 1, 127));
}