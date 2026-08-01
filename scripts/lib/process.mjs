import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function run(command, args, options = {}) {
    try {
        return await execFileAsync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
    } catch (error) {
        if (error.stdout) process.stderr.write(error.stdout);
        if (error.stderr) process.stderr.write(error.stderr);
        throw error;
    }
}
