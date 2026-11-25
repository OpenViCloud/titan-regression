import * as fs from 'node:fs'
import { RESULTS, log, sleep } from './api'

// The steps the agent does outside the runner: those of phase4/ on the Incus host, and the holds of
// backup/command-wait, backup/config-again and backup/restore (cli/edge has a hold of its own). At each HOLD the spec logs what it holds and waits for RESULTS/go-<step>
// (or RESULTS/skip-<step>: the step was not run, or for bak20 and bak22 its verdict came before the answer), which
// `python3 phase4.py` creates in the pod: `step`, `go|skip`, `vm35`, `bak20`, `bak22`, `bak28`, `bak36` (README.md §Phase 4).

export const HOLD_MS = 45 * 60_000

// true on go-<step>, false on skip-<step>; throws after maxMs
export async function hold(step: string, facts: Record<string, unknown>, maxMs: number = HOLD_MS): Promise<boolean> {
  log(`HOLD ${step} ${JSON.stringify(facts)}`)
  const started = Date.now()
  while (true) {
    if (fs.existsSync(`${RESULTS}/go-${step}`)) {
      log(`GO ${step}`)
      return true
    }
    if (fs.existsSync(`${RESULTS}/skip-${step}`)) {
      log(`SKIP ${step}`)
      return false
    }
    if (Date.now() - started > maxMs) {
      throw new Error(`HOLD ${step}: no go after ${maxMs / 60_000} minutes`)
    }
    await sleep(5_000)
  }
}
