import { errorMessage } from '../logger.js'

export class ContractServiceError extends Error {
  constructor(
    message: string,
    public readonly causeValue?: unknown,
  ) {
    super(message)
  }
}

export async function contractCall<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    throw new ContractServiceError(`${label} failed: ${errorMessage(err)}`, err)
  }
}
