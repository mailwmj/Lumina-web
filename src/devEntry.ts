async function startLumina(): Promise<void> {
  if (import.meta.env.DEV && typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  await import('./main');
}

void startLumina();
