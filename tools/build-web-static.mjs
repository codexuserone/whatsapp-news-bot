import { spawn } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const executable = isWin ? (process.env.ComSpec || 'cmd.exe') : command;
    const executableArgs = isWin ? ['/d', '/s', '/c', command, ...args] : args;
    const child = spawn(executable, executableArgs, {
      stdio: 'inherit',
      shell: false
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });

const exists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  await run('npm', ['run', 'build', '--prefix', 'apps/web']);

  const outDir = path.resolve('apps/web/out');
  const publicDir = path.resolve('server/public');

  if (!(await exists(outDir))) {
    throw new Error('apps/web/out was not generated. Verify Next.js static export configuration.');
  }

  await fs.rm(publicDir, { recursive: true, force: true });
  await fs.mkdir(publicDir, { recursive: true });
  await fs.cp(outDir, publicDir, { recursive: true });

  const indexPath = path.join(publicDir, 'index.html');
  if (!(await exists(indexPath))) {
    throw new Error('server/public/index.html is missing after static copy.');
  }

  console.log('Static web build copied to server/public');
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
