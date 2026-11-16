export class ResponseDeliveryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ResponseDeliveryError";
  }
}

export class RequestNotPendingError extends ResponseDeliveryError {
  constructor() {
    super("Relay request is no longer pending");
    this.name = "RequestNotPendingError";
  }
}

export function createResponseDelivery(control, recoverUntilReady) {
  return async (command, payload) => {
    try {
      let result = await control.postResponse(command, payload);
      checkPending(result);
      if (!accepted(result)) {
        const ready = await recoverUntilReady("response delivery recovery", result);
        if (ready === false) {
          throw new ResponseDeliveryError("Response delivery stopped during recovery");
        }
        result = await control.postResponse(command, payload);
        checkPending(result);
      }
      if (!accepted(result)) {
        throw new ResponseDeliveryError(
          `Response delivery failed status=${result.status}`,
        );
      }
    } catch (error) {
      if (error instanceof ResponseDeliveryError) throw error;
      throw new ResponseDeliveryError("Response delivery failed", { cause: error });
    }
  };
}

function checkPending(result) {
  // Only postResponse results reach here. A proxy/SSO 404 is not terminal.
  if (!result.networkError && result.status === 404
    && result.json?.error?.code === "request_not_found") {
    throw new RequestNotPendingError();
  }
}

function accepted(result) {
  return !result.networkError && result.status === 200
    && result.contentType?.toLowerCase().includes("application/json")
    && result.json?.status === "ok";
}
