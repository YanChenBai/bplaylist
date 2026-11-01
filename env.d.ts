declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;

  export default component;
}

declare module '*?inject' {
  const script: string;

  export default script;
}
