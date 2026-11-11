export class WhatsAppBroker {
  constructor(env: unknown, catalog: unknown[]);
  handle(request: Request): Promise<Response | null>;
}
