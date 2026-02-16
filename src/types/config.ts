export interface Config {
  username: string;
  password: string;
  nsHost?: string;
  nsBaseUrl?: string;
  nsSecret: string;
  interval: number;
  sgvLimit: number;
  maxRetryDuration: number;
  verbose: boolean;
  patientId?: string;
  countryCode: string;
  language: string;
}
