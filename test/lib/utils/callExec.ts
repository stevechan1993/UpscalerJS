const { exec } = require("child_process");
type StdOut = (chunk: string) => void;
const callExec = (cmd: string, options: any, stdout?: StdOut) => new Promise((resolve, reject) => {
  const spawnedProcess = exec(cmd, options, (error) => {
    if (error) {
      reject(error.message);
    } else {
      resolve();
    }
  });
  spawnedProcess.stderr.pipe(process.stderr);

  if (stdout) {
    spawnedProcess.stdout.on('data', stdout);
  } else {
    spawnedProcess.stdout.pipe(process.stdout);
  }
})
export default callExec;