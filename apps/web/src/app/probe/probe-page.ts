import {
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { describeError, member } from './probe-guards';
import {
  listCameras,
  parseWindowSeconds,
  runProbe,
  type CameraSection,
  type EncodersSection,
  type PartialReport,
  type ProbeReport,
  type ProbeScope,
  type SectionKey,
  type VideoInput,
} from './probe-report';
import { describeAbsent, isAbsent, type Probed } from './probe-types';
import { reportFileName, sectionRows, withLabel, type ReportRow } from './report-format';

interface SectionView {
  readonly key: SectionKey;
  readonly title: string;
  readonly about: string;
  readonly rows: readonly ReportRow[];
  /** The encoder checks get a table of their own. */
  readonly encoders: readonly EncoderRow[] | undefined;
}

interface EncoderRow {
  readonly codec: string;
  readonly framerate: string;
  readonly acceleration: string;
  readonly supported: string;
  readonly absent: boolean;
}

/** The report's sections, in its order, with a title and a one-line explanation each. */
const SECTIONS: readonly Pick<SectionView, 'key' | 'title' | 'about'>[] = [
  { key: 'device', title: 'Device', about: 'Screen, pixel ratio, cores and memory.' },
  {
    key: 'camera',
    title: 'Camera',
    about:
      'The video inputs, the one measured, and the constraints that opened it: 1920×1080 at ' +
      'ideally 60 fps, else any mode of that camera, else any camera.',
  },
  {
    key: 'capabilities',
    title: 'Camera capabilities',
    about:
      'getCapabilities(), raw. Manual exposure needs exposureMode "manual" plus exposureTime ' +
      '(in 100 µs units) and iso.',
  },
  { key: 'settings', title: 'Camera settings', about: 'getSettings(), raw.' },
  {
    key: 'timing',
    title: 'Frame timing',
    about:
      'requestVideoFrameCallback after a 1 s warm-up; times in ms. captureMinusNowMs is ' +
      'captureTime − performance.now() in the callback; the spread of captureMinusMediaMs is ' +
      'the arrival jitter.',
  },
  {
    key: 'encoders',
    title: 'H.264 encoders',
    about: 'VideoEncoder.isConfigSupported() at 1920×1080.',
  },
  {
    key: 'worker',
    title: 'Worker',
    about: 'MediaStreamTrackProcessor and VideoEncoder in a dedicated worker and on the page.',
  },
  { key: 'storage', title: 'Storage', about: 'navigator.storage estimate (bytes) and persisted.' },
  {
    key: 'bluetooth',
    title: 'Bluetooth',
    about: 'Web Bluetooth, and the two methods that read a cube’s MAC address automatically.',
  },
  {
    key: 'hints',
    title: 'Browser',
    about: 'User-agent client hints: architecture and bitness tell a 32-bit Chrome apart.',
  },
];

/**
 * `/probe`: what this browser can do with its cameras, encoders, storage and Bluetooth, as a
 * JSON report to copy or download for docs/DEVICES.md (docs/PLAN.md, T1.8). `?seconds=N`
 * shortens the timing measurement (the end-to-end test uses 2).
 */
@Component({
  selector: 'app-probe-page',
  templateUrl: './probe-page.html',
  styleUrl: './probe-page.scss',
})
export class ProbePage {
  private readonly document = inject(DOCUMENT);
  private readonly scope: ProbeScope = inject(BROWSER_GLOBALS);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly stop = new AbortController();
  private readonly preview = viewChild.required<ElementRef<HTMLVideoElement>>('preview');
  private readonly sections = signal<PartialReport>({});
  private readonly result = signal<ProbeReport | undefined>(undefined);

  protected readonly seconds = parseWindowSeconds(
    inject(ActivatedRoute).snapshot.queryParamMap.get('seconds'),
  );
  protected readonly label = signal('');
  protected readonly videoInputs = signal<readonly VideoInput[]>([]);
  protected readonly selectedDeviceId = signal('');
  protected readonly busy = signal(false);
  protected readonly status = signal('Not run yet.');
  protected readonly notice = signal('');
  protected readonly jsonOpen = signal(false);

  /** The finished report, with the label as currently typed. */
  protected readonly report = computed(() => {
    const result = this.result();
    return result && withLabel(result, this.label());
  });
  protected readonly json = computed(() => {
    const report = this.report();
    return report ? JSON.stringify(report, null, 2) : '';
  });
  protected readonly views = computed<readonly SectionView[]>(() => {
    const sections = this.sections();
    return SECTIONS.flatMap((section) => {
      const value = sections[section.key];
      return value === undefined
        ? []
        : [
            {
              ...section,
              rows: sectionRows(value),
              encoders: section.key === 'encoders' ? encoderRows(sections.encoders) : undefined,
            },
          ];
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stop.abort();
    });
  }

  protected allowCamera(): void {
    void this.listCameras();
  }

  protected run(): void {
    void this.runProbe();
  }

  protected copy(): void {
    void this.copyReport();
  }

  protected download(): void {
    const report = this.report();
    const urls = member(this.scope, 'URL');
    if (!report) {
      return;
    }
    if (typeof member(urls, 'createObjectURL') !== 'function') {
      this.showJsonInstead('Downloads are not available here');
      return;
    }
    const objectUrls = urls as typeof URL;
    const href = objectUrls.createObjectURL(new Blob([this.json()], { type: 'application/json' }));
    const link = this.document.createElement('a');
    link.href = href;
    link.download = reportFileName(report.label, report.generatedAt);
    this.document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => {
      objectUrls.revokeObjectURL(href);
    }, 60_000);
    this.diagnostics.record('files.downloaded', { what: 'probe', files: 1, names: link.download });
    this.notice.set(`Saved ${link.download}.`);
  }

  private async listCameras(): Promise<void> {
    this.busy.set(true);
    this.status.set('Waiting for the camera permission…');
    const cameras = await listCameras(this.scope);
    if (isAbsent(cameras)) {
      this.status.set(`No camera list: ${describeAbsent(cameras)}.`);
    } else {
      this.showCameras(cameras.videoInputs, undefined);
      const count = cameras.videoInputs.length;
      this.status.set(
        count === 0
          ? 'No camera found.'
          : `${String(count)} camera(s) found. Choose one, then run the probe.`,
      );
    }
    this.busy.set(false);
  }

  private async runProbe(): Promise<void> {
    this.busy.set(true);
    this.result.set(undefined);
    this.sections.set({});
    this.notice.set('');
    const selected = this.selectedDeviceId();
    const report = await runProbe(this.scope, {
      label: this.label(),
      deviceId: selected === '' ? undefined : selected,
      seconds: this.seconds,
      video: this.preview().nativeElement,
      signal: this.stop.signal,
      onProgress: (status, sections) => {
        this.status.set(status);
        this.sections.set(sections);
        this.showCamerasOf(sections.camera);
      },
    });
    if (this.stop.signal.aborted) {
      return;
    }
    this.sections.set(report);
    this.showCamerasOf(report.camera);
    this.result.set(report);
    this.status.set('Done. Copy or download the report.');
    this.busy.set(false);
  }

  private async copyReport(): Promise<void> {
    const clipboard = member(member(this.scope, 'navigator'), 'clipboard');
    if (typeof member(clipboard, 'writeText') !== 'function') {
      this.showJsonInstead('The clipboard is not available here');
      return;
    }
    try {
      await (clipboard as Clipboard).writeText(this.json());
      this.notice.set('Report copied.');
    } catch (error: unknown) {
      this.showJsonInstead(`Copying failed (${describeError(error)})`);
    }
  }

  private showJsonInstead(problem: string): void {
    this.notice.set(`${problem}: select the report JSON below and copy it.`);
    this.jsonOpen.set(true);
  }

  private showCamerasOf(camera: Probed<CameraSection> | undefined): void {
    if (camera !== undefined && !isAbsent(camera)) {
      this.showCameras(camera.videoInputs, camera.selected);
    }
  }

  private showCameras(
    inputs: readonly VideoInput[],
    selected: Probed<VideoInput> | undefined,
  ): void {
    this.videoInputs.set(inputs);
    const wanted =
      selected !== undefined && !isAbsent(selected) ? selected.deviceId : this.selectedDeviceId();
    const known = inputs.some((input) => input.deviceId === wanted);
    this.selectedDeviceId.set(known ? wanted : (inputs.at(0)?.deviceId ?? ''));
  }
}

function encoderRows(encoders: Probed<EncodersSection> | undefined): EncoderRow[] | undefined {
  if (encoders === undefined || isAbsent(encoders)) {
    return undefined;
  }
  return encoders.results.map((check) => ({
    codec: check.codec,
    framerate: String(check.framerate),
    acceleration: check.hardwareAcceleration,
    supported: isAbsent(check.supported)
      ? describeAbsent(check.supported)
      : check.supported
        ? 'yes'
        : 'no',
    absent: isAbsent(check.supported),
  }));
}
