export type AppConfig = {
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: string;
  adminToken: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    databaseUrl: required("DATABASE_URL"),
    logLevel: process.env.LOG_LEVEL ?? "info",
    adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token"
  };
}
