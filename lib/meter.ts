// The control plane's meter tick, OpenViCloud/titan-control-plane:Titan.Application/Options/BillingMeterOptions.cs
// (IntervalMinutes, 10 by default). An environment that sets BillingMeter__IntervalMinutes on the control plane
// gives the runner the same number as METER_INTERVAL_MINUTES (the dev overlay of OpenViCloud/titan-local-cluster:
// gitops/); unset means the default. A value that is not a whole number of minutes throws: a wrong tick would turn
// every billing case red for a reason that is not the product's.
// No imports: selftest runs this file without Playwright.
export const DEFAULT_METER_INTERVAL_MINUTES = 10

export function meterTickMs(minutes: string | undefined): number {
  if (minutes === undefined || minutes.trim() === '') {
    return DEFAULT_METER_INTERVAL_MINUTES * 60_000
  }
  const text = minutes.trim()
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`METER_INTERVAL_MINUTES=${minutes} is not a whole number of minutes`)
  }
  return Number(text) * 60_000
}
