// Fork-only: the same app as vite.config.ts, built code-split instead of as
// one self-contained HTML file, for the cacheable remote-session shell (see
// packages/server/app-shell.ts). Derived from the base config so upstream
// changes to aliases, defines, and plugins carry over untouched.
import { splitBuildConfig } from '../../scripts/fork/split-build-config';
import base from './vite.config';

export default splitBuildConfig(base);
