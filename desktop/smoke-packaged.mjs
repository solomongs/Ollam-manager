import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) {
  console.error('Usage: node desktop/smoke-packaged.mjs <absolute-packaged-executable>');
  process.exit(2);
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-desktop-smoke-'));
const output = path.join(scratch, 'result.json');
const userData = path.join(scratch, 'user-data');
const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
try {
  async function launch() { await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--desktop-smoke-test', `--smoke-output=${output}`, `--smoke-user-data=${userData}`], {shell:false, windowsHide:true, env, stdio:['ignore','ignore','pipe']});
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged desktop smoke timed out after 60 seconds.')); }, 60000);
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Packaged app exited ${code}: ${stderr.slice(0,4096)}`));
    });
  });
    const result = JSON.parse(await fs.readFile(output, 'utf8'));
    if (!result.ok || !result.packaged || !result.rendererIsolated || result.authenticated !== false || !/^http:\/\/127\.0\.0\.1:\d+$/.test(result.origin)) throw new Error('Packaged smoke report failed verification.');
    return result;
  }
  const first = await launch();
  await fs.rm(output);
  const result = await launch();
  if (result.origin !== first.origin || !result.storageRestored) throw new Error('Packaged desktop origin/browser preferences did not persist across launch.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await fs.rm(scratch, {recursive:true, force:true});
}
