import { Injectable, signal } from '@angular/core';

/**
 * Which attempt's clips the clip viewer shows (T2.4): the solve list's clip badge opens it, the
 * viewer closes it, and so does the Timer page when it goes.
 */
@Injectable({ providedIn: 'root' })
export class ClipViewing {
  private readonly indexSignal = signal<number | null>(null);

  /** The attempt's index; null while the viewer is closed. */
  readonly index = this.indexSignal.asReadonly();

  open(index: number): void {
    this.indexSignal.set(index);
  }

  close(): void {
    this.indexSignal.set(null);
  }
}
