import { env } from '../config/env.ts';

export type ExecOutcome = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: string;
  durationMs: number;
  stub: boolean;
};

/**
 * Judge0 CE language ids.
 *
 * These are stable for the hosted CE service; confirm with `GET /languages` if
 * a runtime ever looks wrong. Only languages a room can be created with are
 * listed, so an unsupported value is rejected before any network call.
 */
const LANGUAGE_IDS: Record<string, number> = {
  javascript: 63,
  python: 71,
  cpp: 54,
  java: 62,
};

// Judge0 status ids below 3 mean queued or running; 3 is a clean run and
// anything above is a failure of some kind (compile error, timeout, signal).
const STATUS_IN_PROGRESS = 3;

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 20_000;

// Output goes into the shared document and therefore into snapshots, so it is
// capped rather than stored in full.
const MAX_OUTPUT_CHARS = 8_000;

export class ExecError extends Error {
  /** 400 for a bad request, 502 when the execution service is at fault. */
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function isSupportedLanguage(language: string): boolean {
  return language in LANGUAGE_IDS;
}

export function isStubbed(): boolean {
  return !env.judge0ApiKey;
}

function truncate(value: string | null | undefined): string {
  const text = value ?? '';
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…output truncated at ${MAX_OUTPUT_CHARS} characters`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'X-RapidAPI-Key': env.judge0ApiKey,
    'X-RapidAPI-Host': env.judge0Host,
  };
}

/**
 * Runs source through Judge0 and waits for a terminal status.
 *
 * Submits and then polls rather than using `wait=true`: synchronous submission
 * is disabled on several Judge0 deployments, and a request that blocks for the
 * full run holds a connection open for no benefit.
 */
async function runOnJudge0(language: string, source: string): Promise<ExecOutcome> {
  const startedAt = Date.now();

  const created = await fetch(
    `${env.judge0Url}/submissions?base64_encoded=false&wait=false`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        language_id: LANGUAGE_IDS[language],
        source_code: source,
      }),
    },
  );

  if (!created.ok) {
    throw new ExecError(
      created.status === 429
        ? 'The execution service is rate limiting us. Try again shortly.'
        : `Execution service rejected the submission (HTTP ${created.status})`,
    );
  }

  const { token } = (await created.json()) as { token?: string };
  if (!token) throw new ExecError('Execution service returned no submission token');

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    if (Date.now() > deadline) {
      throw new ExecError('Execution timed out waiting for a result');
    }

    await sleep(POLL_INTERVAL_MS);

    const res = await fetch(
      `${env.judge0Url}/submissions/${token}?base64_encoded=false`,
      { headers: headers() },
    );
    if (!res.ok) continue;

    const body = (await res.json()) as {
      status?: { id: number; description: string };
      stdout?: string | null;
      stderr?: string | null;
      compile_output?: string | null;
      exit_code?: number | null;
      time?: string | null;
    };

    if (!body.status || body.status.id < STATUS_IN_PROGRESS) continue;

    // A compile failure carries its message in compile_output, not stderr.
    const stderr = body.stderr?.trim() ? body.stderr : (body.compile_output ?? '');

    return {
      stdout: truncate(body.stdout),
      stderr: truncate(stderr),
      exitCode: body.exit_code ?? null,
      status: body.status.description,
      durationMs: Date.now() - startedAt,
      stub: false,
    };
  }
}

/** Deterministic stand-in used when no API key is configured. */
async function runStub(language: string, source: string): Promise<ExecOutcome> {
  const startedAt = Date.now();
  await sleep(150);

  const lines = source.split('\n').length;

  return {
    stdout:
      `[stub executor] No JUDGE0_API_KEY is configured, so nothing was run.\n` +
      `Would have executed ${lines} line(s) of ${language}.\n`,
    stderr: '',
    exitCode: 0,
    status: 'Stubbed',
    durationMs: Date.now() - startedAt,
    stub: true,
  };
}

export async function execute(language: string, source: string): Promise<ExecOutcome> {
  if (!isSupportedLanguage(language)) {
    throw new ExecError(`Language "${language}" cannot be executed`, 400);
  }
  if (!source.trim()) {
    throw new ExecError('There is no code to run', 400);
  }

  return isStubbed() ? runStub(language, source) : runOnJudge0(language, source);
}
