// Fork-only: code-split build of the review app. See apps/hook/vite.split.config.ts.
import { splitBuildConfig } from '../../scripts/fork/split-build-config';
import base from './vite.config';

export default splitBuildConfig(base);
