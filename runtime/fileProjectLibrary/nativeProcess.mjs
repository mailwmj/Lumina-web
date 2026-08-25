import { spawn } from 'node:child_process';

export function createNativeJsonSession(command, arguments_, { idleTimeoutMs = 100 } = {}) {
  let child = null;
  let pending = [];
  let idleTimer = null;
  let retained = 0;

  const stopIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const failPending = (error) => {
    const requests = pending;
    pending = [];
    for (const request of requests) request.reject(error);
  };
  const closeIdleChild = () => {
    idleTimer = null;
    if (!child || pending.length > 0 || retained > 0) return;
    const current = child;
    child = null;
    current.stdin.end();
  };
  const scheduleIdleClose = () => {
    stopIdleTimer();
    if (!child || pending.length > 0 || retained > 0) return;
    idleTimer = setTimeout(closeIdleChild, idleTimeoutMs);
  };
  const start = () => {
    const current = spawn(command, arguments_, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = current;
    let stdout = '';
    let stderr = '';
    const fail = (error) => {
      if (child === current) child = null;
      failPending(error);
    };
    current.once('error', fail);
    current.stdout.setEncoding('utf8');
    current.stderr.setEncoding('utf8');
    current.stdout.on('data', (chunk) => {
      stdout += chunk;
      while (true) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line === '') continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          error.code ??= 'ENOTSUP';
          fail(error);
          return;
        }
        const request = pending.shift();
        if (!request) {
          const error = new Error('Native durable helper returned an unexpected response.');
          error.code = 'ENOTSUP';
          fail(error);
          return;
        }
        if (!response?.ok) {
          const error = new Error(response?.message || 'Native durable helper rejected the operation.');
          error.code = response?.code || 'ENOTSUP';
          request.reject(error);
        } else {
          request.resolve(response.result);
        }
      }
      scheduleIdleClose();
    });
    current.stderr.on('data', (chunk) => { stderr += chunk; });
    current.once('exit', (code) => {
      if (child === current) child = null;
      if (pending.length === 0) return;
      const error = new Error(stderr.trim() || 'Native durable helper exited with code ' + code + '.');
      error.code = 'ENOTSUP';
      failPending(error);
    });
  };

  return Object.freeze({
    retain() {
      retained += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained -= 1;
        scheduleIdleClose();
      };
    },
    request(input) {
      stopIdleTimer();
      if (!child) start();
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write(JSON.stringify(input) + '\n', (error) => {
          if (error) {
            const failure = new Error(error.message);
            failure.code = error.code || 'ENOTSUP';
            failPending(failure);
          }
        });
      });
    },
  });
}

export async function runNativeJsonProcess(command, arguments_, input) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, arguments_, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', fail);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      if (settled) return;
      if (code !== 0) {
        const error = new Error(stderr.trim() || `Native durable helper exited with code ${code}.`);
        error.code = 'ENOTSUP';
        fail(error);
        return;
      }
      try {
        const response = JSON.parse(stdout);
        if (!response?.ok) {
          const error = new Error(response?.message || 'Native durable helper rejected the operation.');
          error.code = response?.code || 'ENOTSUP';
          fail(error);
          return;
        }
        settled = true;
        resolve(response.result);
      } catch (error) {
        error.code ??= 'ENOTSUP';
        fail(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
