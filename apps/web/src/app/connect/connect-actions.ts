import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { CubeService } from '../cube/cube-service';
import { ConnectDialogService } from './connect-dialog-service';

/**
 * What the connect controls do (docs/PLAN.md, T1.12), shared by the header pill, the Timer page's
 * "Connect a cube" (also in the live cube panel) and the connect dialog.
 */
@Injectable({ providedIn: 'root' })
export class ConnectActions {
  private readonly cube = inject(CubeService);
  private readonly dialogs = inject(ConnectDialogService);
  private readonly router = inject(Router);

  /**
   * Connects a cube, or connects the last one again. Chrome opens its device picker only while it
   * handles a click (Web Bluetooth's `requestDevice` needs the click's user activation), so this
   * runs from the click itself and nothing before the picker waits for the user. In a browser
   * without Web Bluetooth it opens the dialog instead, which says so and offers the demo cube.
   */
  connect(): void {
    if (!this.cube.support.available) {
      this.dialogs.open('support');
      return;
    }
    void (this.cube.canReconnect() ? this.cube.reconnect() : this.cube.connect());
  }

  /** Gives up connecting (or disconnects the cube). */
  cancel(): void {
    void this.cube.disconnect();
  }

  /**
   * The demo cube: the solve, speed, mis-scramble and gyroscope of the address's `?demo=`,
   * `?speed=`, `?misscramble=` and `?gyro=`, if any; else a random solve at the speed set in
   * Settings, without a gyroscope.
   */
  demo(): void {
    const query = this.router.routerState.snapshot.root.queryParamMap;
    void this.cube.startDemo({
      demo: query.get('demo'),
      speed: query.get('speed'),
      misscramble: query.get('misscramble'),
      gyro: query.get('gyro'),
    });
  }

  /** The dialog on the last failure: the error, what this browser can do, Connect and Demo cube. */
  details(): void {
    this.dialogs.open('error');
  }
}
