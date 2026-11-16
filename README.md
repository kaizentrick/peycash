# PeyCash

PeyCash ayuda a comercios en México a cobrar con CoDi mediante Pey. El cliente autoriza el cobro en la app de su banco. El comercio recibe el dinero en su propia cuenta y PeyCash confirma el abono por webhook.

**Proyecto para Cursor Hackatón México.** El prototipo tiene una solicitud de $0.01 MXN, QR real cuando se configura Pey, confirmación por webhook y devolución simulada. Los tres canales de la demo representan las entradas previstas para Shopify, la caja y un agente.

- [Demo y presentación del proyecto](https://pey.kaizentrick.com/)
- [Alcance y plan de cuatro semanas](PRODUCTO.md)

## Ejecutar

Se necesita Node.js 22.13 o posterior.

```sh
npm ci
npm test
npm start
```

Abre http://localhost:3000 y selecciona un canal. En simulación puedes crear un cobro, compartir su enlace, simular el abono y recorrer la devolución. En el canal de caja, el ticket de prueba se puede imprimir desde el navegador o compartir manualmente por WhatsApp.

## Prueba CoDi de $0.01 MXN

1. Genera una API key de Pey vinculada a una cuenta CoDi autorizada para las pruebas. Usa una cuenta dedicada al proyecto.
2. Configura un webhook en Pey hacia `https://pey.kaizentrick.com/api/webhooks/pey` y conserva en el gestor de secretos la firma de webhook que proporciona Pey.
3. Configura `PEY_API_KEY`, `PEY_WEBHOOK_SECRET` y `PEY_OPERATOR_TOKEN` en el servidor. Usa un token de operación aleatorio, independiente de la llave de Pey. Opcionalmente, configura `PEY_BANK_ACCOUNT_ID` para seleccionar explícitamente la cuenta de destino. El almacenamiento debe estar en un directorio persistente (`PEY_DATA_DIR`).
4. En la demo, elige «Cobro real · Pey CoDi» y usa el token de operación. Escanea con una aplicación bancaria con CoDi habilitado, revisa el importe y el beneficiario, y autoriza. La pantalla pasa a «Pago CoDi confirmado por Pey» al recibir un webhook firmado con el mismo QR y monto.
5. Las acciones de devolución modifican únicamente una simulación de interfaz. No envían una transferencia.

La documentación del evento lista cuentas preautorizadas para el cobro de prueba. La cuenta de pruebas general de Pey no devuelve pagos. No guardes ni publiques claves, mensajes bancarios, CLABEs ni comprobantes reales en el repositorio.

[API de Pey](https://docs.pey.mx/) · [Webhooks de Pey](https://docs.pey.mx/docs/tutorials/getting-started/set-up-webhooks/) · [Hackathon](https://aibuilders.mx/cursor-hackathon)

## Vista previa en Shopify POS

1. Crea o vincula una app de desarrollo en Shopify. Copia `shopify.app.toml.example` a `shopify.app.toml` y usa el client ID de esa app.
2. En PeyCash configura `SHOPIFY_API_KEY` (client ID), `SHOPIFY_API_SECRET` y `SHOPIFY_POS_DEV_SHOP` (dominio exacto `.myshopify.com`), además de las credenciales de Pey descritas arriba. La extensión usa el backend HTTPS de PeyCash.
3. Ejecuta `shopify app dev` con la tienda de desarrollo. En Dev Console selecciona **Mobile preview** y escanea el QR de instalación con un teléfono o tablet que haya iniciado sesión en esa tienda en Shopify POS.
4. En Shopify, configura **CoDi** como método de pago personalizado en la ubicación de prueba. En POS prepara un carrito cuyo total sea exactamente **$0.01 MXN**. Abre **Cobrar con CoDi** desde la cuadrícula, genera el QR y autoriza el centavo en la app bancaria. Este paso mueve dinero real a través de Pey, fuera del procesamiento de pagos de Shopify.
5. Cuando llegue la confirmación de Pey, vuelve a la caja, registra el pago externo como **CoDi**, cierra la venta e imprime el recibo nativo en una impresora vinculada. Si la tienda de desarrollo bloquea el registro del método manual, valida ese último tramo con una tienda piloto habilitada. La extensión no registra un pago por su cuenta.

[Vista previa de Shopify POS](https://shopify.dev/docs/apps/build/pos/getting-started) · [Métodos de Shopify POS](https://help.shopify.com/en/manual/sell-in-person/getting-started/setup-payment-method/enable-payments)
