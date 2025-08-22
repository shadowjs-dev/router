import { onMount } from "@shadow-js/core";
import { getActiveRouter } from "../context";

export function Redirect<T = unknown>(props: {
  to: string;
  replace?: boolean;
  state?: T;
}) {
  onMount(() => {
    try {
      getActiveRouter().navigate(props.to, {
        replace: props.replace ?? true,
        state: props.state,
      });
    } catch {}
  });
  return document.createDocumentFragment();
}
