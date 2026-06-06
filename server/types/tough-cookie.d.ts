declare module 'tough-cookie' {
  export class Cookie {
    static parse(cookieString: string): Cookie | undefined;
  }
}
