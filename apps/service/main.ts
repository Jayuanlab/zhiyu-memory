// Deployment selects a trusted installed project, never a module from request JSON.
if (process.env.MEMORY_SERVICE_PROJECT_MODULE) await import('./installed');
else await import('./demo');
export {};
