import { Component, computed, inject } from '@angular/core';

import { CubeConnect } from '../connect/cube-connect';
import { CubeNet } from './cube-net';
import { CubeService } from './cube-service';
import { MOVE_LOG_ROWS, moveLogRows } from './move-log';

/**
 * The live cube panel of the timer page (docs/PLAN.md, T1.6a): the connected cube's state as a
 * net, whether it is solved, and its latest moves with their cube times, the gaps between them
 * and the Bluetooth packet boundaries; "Connect a cube" while none is connected (T1.12).
 * docs/MANUAL-TESTS.md T1.5 is run by reading it.
 */
@Component({
  selector: 'app-live-cube-panel',
  imports: [CubeConnect, CubeNet],
  templateUrl: './live-cube-panel.html',
  styleUrl: './live-cube-panel.scss',
})
export class LiveCubePanel {
  protected readonly cube = inject(CubeService);
  protected readonly rows = computed(() =>
    moveLogRows(this.cube.moves(), this.cube.moveCount(), MOVE_LOG_ROWS),
  );
}
