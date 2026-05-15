import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface YtDlpRunResult {
  stdout: string;
  stderr: string;
}

function resolveYtDlpBin(): string {
  const envBin = process.env.YT_DLP_BIN?.trim();
  if (envBin) {
    return envBin;
  }

  // Resolve project root (works from both server/ and root)
  const projectRoot = path.resolve(__dirname, '..', '..');

  // Try common locations (priority order)
  const commonPaths = [
    path.join(projectRoot, '.venv', 'bin', 'yt-dlp'), // uv-managed venv
    path.resolve(process.cwd(), '.venv', 'bin', 'yt-dlp'), // cwd venv
    'yt-dlp', // System PATH
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ];

  for (const binPath of commonPaths) {
    try {
      if (binPath.startsWith('/') && fs.existsSync(binPath)) {
        return binPath;
      }
    } catch (e) {
      // Continue to next path
    }
  }

  return 'yt-dlp'; // Default to system PATH
}

export function getYtDlpBinPath(): string {
  return resolveYtDlpBin();
}

export async function runYtDlp(args: string[]): Promise<YtDlpRunResult> {
  const ytDlpBin = getYtDlpBinPath();
  console.log(`[yt-dlp] bin=${ytDlpBin}`);
  console.log(`[yt-dlp] args=${JSON.stringify(args)}`);

  // Auto-inject cookies from browser if available and not already present
  const hasCookies = args.some(a => a.startsWith('--cookies'));
  const extraArgs: string[] = [];
  if (!hasCookies) {
    const browser = process.env.YT_DLP_COOKIES_BROWSER;
    if (browser) {
      extraArgs.push('--cookies-from-browser', browser);
    }
  }

  return await new Promise((resolve, reject) => {
    const TIMEOUT_MS = 120 * 1000; // 2 minutes
    const child = spawn(ytDlpBin, [...extraArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`yt-dlp timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`yt-dlp exited with code ${code}. stderr=${stderr || '(empty)'}`));
    });
  });
}
