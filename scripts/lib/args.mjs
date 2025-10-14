export function parseNumberArg(name, def) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && i + 1 < argv.length) {
      const v = Number(argv[i + 1]);
      if (!Number.isNaN(v)) return v;
    }
    if (arg.startsWith(`--${name}=`)) {
      const v = Number(arg.split('=')[1]);
      if (!Number.isNaN(v)) return v;
    }
  }
  return def;
}

export function parsePathArg(name, defAbs) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && i + 1 < argv.length) {
      const v = argv[i + 1];
      if (v) return require('path').resolve(process.cwd(), v);
    }
    if (arg.startsWith(`--${name}=`)) {
      const v = arg.split('=')[1];
      if (v) return require('path').resolve(process.cwd(), v);
    }
  }
  return defAbs;
}

export function parseStringArg(name, def) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.split('=')[1];
    }
  }
  return def;
}

export function parseFlagArg(name) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) return true;
    if (arg.startsWith(`--${name}=`)) {
      const v = arg.split('=')[1];
      if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
      if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    }
  }
  return false;
}

export function hasArg(name) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) return true;
    if (arg.startsWith(`--${name}=`)) return true;
  }
  return false;
}


