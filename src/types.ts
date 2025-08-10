export interface EtcdConnection {
  id: string;
  name: string;
  endpoints: string[];
  username?: string;
  password?: string;
  envTag?: 'dev' | 'prod' | 'staging' | 'qa';
  colorTheme?: 'charts.green' | 'charts.red' | 'charts.blue' | 'charts.yellow' | 'charts.orange' | 'charts.purple';
}


