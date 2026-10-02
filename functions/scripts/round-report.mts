// The coordinator's round report (docs/PLAN.md T3.9, docs/DIAGNOSTICS.md): reads the diagnostics
// events of every account (users/{uid}/events, docs/DATA-MODEL.md §10) with the Admin SDK, past the
// rules, and prints the Markdown of report.mts: the events per device and day, the checklists of
// docs/MANUAL-TESTS.md with the evidence found, and the last failures.
//
//   npm run round-report -- --days 7
//
// with GOOGLE_APPLICATION_CREDENTIALS naming a service-account key file of the project (the Admin
// SDK reads it; nothing here reads the key, or any other variable, and nothing prints it). Node 22
// runs this file as it is (type stripping); it lives under functions/ because firebase-admin is the
// functions' dependency, and the deploy ignores this folder (firebase.json). Options: --days N (7),
// the days back from now; --limit N (20000), the most events read per account; --uid <uid>, one
// account only.
import { pathToFileURL } from 'node:url';

import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { readEvent, roundReport, type ReportEvent } from './report.mts';

interface Options {
  readonly days: number;
  readonly limit: number;
  readonly uid: string | null;
}

/** The command line's options, with their defaults; throws on one it does not know. */
export function parseArgs(argv: readonly string[]): Options {
  let days = 7;
  let limit = 20_000;
  let uid: string | null = null;
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const value = (): string => {
      if (k + 1 >= argv.length) {
        throw new Error(`${arg} needs a value.`);
      }
      k++;
      return argv[k];
    };
    switch (arg) {
      case '--days':
        days = Number(value());
        break;
      case '--limit':
        limit = Number(value());
        break;
      case '--uid':
        uid = value();
        break;
      default:
        throw new Error(`Unknown option ${arg}. Options: --days N, --limit N, --uid <uid>.`);
    }
  }
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(limit) || limit <= 0) {
    throw new Error('--days and --limit take positive numbers.');
  }
  return { days, limit, uid };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.env['GOOGLE_APPLICATION_CREDENTIALS'] === undefined) {
    throw new Error(
      'Set GOOGLE_APPLICATION_CREDENTIALS to the path of a service-account key file of the project (docs/DIAGNOSTICS.md).',
    );
  }
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const nowMs = Date.now();
  const sinceMs = nowMs - options.days * 24 * 60 * 60 * 1000;
  // Each account's events in turn (one owner today): a collection group query would need an index
  // of its own, and the accounts are few.
  const accounts =
    options.uid === null
      ? (await db.collection('users').listDocuments()).map((ref) => ref.id)
      : [options.uid];
  const events: ReportEvent[] = [];
  for (const uid of accounts) {
    const snapshot = await db
      .collection('users')
      .doc(uid)
      .collection('events')
      .where('tsMs', '>=', sinceMs)
      .orderBy('tsMs')
      .limit(options.limit)
      .get();
    for (const doc of snapshot.docs) {
      const event = readEvent(uid, doc.id, doc.data());
      if (event !== null) {
        events.push(event);
      }
    }
    if (snapshot.size >= options.limit) {
      console.error(
        `warning: account ${uid.slice(0, 6)}… has more than ${String(options.limit)} events in the span; raise --limit or shorten --days.`,
      );
    }
  }
  process.stdout.write(roundReport(events, { days: options.days, nowMs }));
  process.stdout.write('\n');
}

// Run when executed, not when imported (the test imports parseArgs).
if (process.argv.length > 1 && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
