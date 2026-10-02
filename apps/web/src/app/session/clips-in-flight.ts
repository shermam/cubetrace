import { Injectable, signal } from '@angular/core';

/**
 * The attempts whose clips the recording is still to save (T2.4: each clip a second after its
 * segment, then added to the attempt's record), and whose gyro file the session service is still to
 * write (T3.7: a second after the attempt, then its summary added to the record), so that the upload
 * queue (T3.3) sends an attempt once its record is final: both clips and the gyro file saved, or
 * known absent. The recording and the session service say when one is planned and when it is saved,
 * failed or dropped; nothing else imports the recording.
 */
@Injectable({ providedIn: 'root' })
export class ClipsInFlight {
  private readonly counts = new Map<string, number>();
  private readonly versionSignal = signal(0);

  /** Changes whenever an attempt's clips to come do. */
  readonly version = this.versionSignal.asReadonly();

  /** A clip of attempt `index` of session `sessionId` is planned. */
  begin(sessionId: string, index: number): void {
    const key = keyOf(sessionId, index);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.versionSignal.update((version) => version + 1);
  }

  /** A clip planned is saved, failed or dropped. */
  end(sessionId: string, index: number): void {
    const key = keyOf(sessionId, index);
    const count = (this.counts.get(key) ?? 0) - 1;
    if (count > 0) {
      this.counts.set(key, count);
    } else {
      this.counts.delete(key);
    }
    this.versionSignal.update((version) => version + 1);
  }

  /** Whether a clip of attempt `index` of session `sessionId` is still to come. */
  has(sessionId: string, index: number): boolean {
    return this.counts.has(keyOf(sessionId, index));
  }
}

function keyOf(sessionId: string, index: number): string {
  return `${sessionId}/${String(index)}`;
}
