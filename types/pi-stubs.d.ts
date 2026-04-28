// Stub declarations for Pi platform peer dependencies (not available on npm)

declare module "@mariozechner/pi-ai" {
  export function StringEnum<T extends readonly string[]>(values: T): unknown;
}

declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    on: (event: string, handler: (...args: any[]) => any) => void;
    registerTool: (tool: any) => void;
    registerCommand: (name: string, command: any) => void;
    sendUserMessage: (message: string) => void;
  }
  export interface ExtensionContext {
    cwd: string;
    sessionManager: { getSessionId: () => string };
    ui: {
      theme: any;
      notify: (message: string, type?: string) => void;
      setWidget: (id: string, content: any) => void;
    };
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
  }
}

declare module "@mariozechner/pi-tui" {
  export interface AutocompleteItem {
    value: string;
    description?: string;
  }
}

declare module "typebox" {
  export const Type: {
    Object: (props: any, options?: any) => any;
    Optional: (prop: any) => any;
    String: (options?: any) => any;
    Number: (options?: any) => any;
  };
}
