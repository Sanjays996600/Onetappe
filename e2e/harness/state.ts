import { readFileSync } from 'node:fs';
import { STATE_FILE } from './paths.js';

/** What the running stack exposes to the tests (written by global setup). */
export interface StackState {
  readonly apiUrl: string;
  readonly adminUrl: string;
  readonly customerUrl: string;
  readonly workerUrl: string;
  readonly apiLog: string;
  readonly superAdmin: { readonly email: string; readonly invitationToken: string };
  readonly world: {
    readonly cityId: string;
    readonly zoneId: string;
    readonly pincode: string;
    readonly center: { readonly lat: number; readonly lng: number };
    readonly day: string;
    readonly service: { readonly id: string; readonly code: string; readonly name: string };
    readonly workers: ReadonlyArray<{ readonly id: string; readonly phone: string }>;
  };
}

export function stack(): StackState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState;
}
