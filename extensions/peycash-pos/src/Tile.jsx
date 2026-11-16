import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default function tile() {
  render(
    <s-tile heading="Cobrar con CoDi" subheading="PeyCash" onClick={() => shopify.action.presentModal()} />,
    document.body,
  );
}
