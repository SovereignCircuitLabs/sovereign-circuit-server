import { getAddress, isAddress, type Address } from 'viem'

export function assertAddress(value: unknown, fieldName: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${fieldName} must be a valid EVM address`)
  }
  return getAddress(value)
}

export function parseUint256String(value: unknown, fieldName: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be a uint256 decimal string`)
  }
  return BigInt(value)
}

export function parseUint256Param(value: string | undefined, fieldName: string): bigint {
  return parseUint256String(value, fieldName)
}

export function assertBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`)
  }
  return value
}

export function requiredConfiguredAddress(value: Address | '', envName: string): Address {
  if (!value) {
    throw new Error(`${envName} is not configured`)
  }
  return assertAddress(value, envName)
}
