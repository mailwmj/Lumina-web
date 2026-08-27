import { version as packageVersion } from '../../package.json';

export const runtime = {
  getAppVersion: async (): Promise<string> => import.meta.env.VITE_APP_VERSION || packageVersion,
};
