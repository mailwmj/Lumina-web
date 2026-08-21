export const runtime = {
  getAppVersion: async (): Promise<string> => import.meta.env.VITE_APP_VERSION || '0.2.37',
};
