/**
 * Entrypoint for the multi-file `tree` / `reach` demo.
 * Try:
 *   node dist/cli.js tree -e runCheckout -- examples/checkout
 *   node dist/cli.js reach -e runCheckout --to sendEmail -- examples/checkout
 */
import { Cart } from "./cart.js";
import { Inventory } from "./inventory.js";
import { PaymentGateway } from "./payments.js";
import { notifyCustomer } from "./notify.js";

export function runCheckout(userId: string, cartId: string) {
  const cart = Cart.load(cartId);
  Cart.validate(cart);

  const reserved = Inventory.reserve(cart);
  if (!reserved) {
    Inventory.releaseHolds(cart);
    notifyCustomer(userId, "out_of_stock");
    return;
  }

  const charge = PaymentGateway.charge(userId, cart);
  if (charge.ok) {
    Cart.markPaid(cart);
    notifyCustomer(userId, "receipt");
  } else {
    Inventory.releaseHolds(cart);
    notifyCustomer(userId, "payment_failed");
  }
}
