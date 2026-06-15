import { formatUnits, parseUnits } from 'viem'

export const USDC_DECIMALS = 6

export function parseUsdc(amount: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new Error('Invalid USDC amount; expected a decimal string with up to 6 decimals')
  }
  return parseUnits(amount, USDC_DECIMALS)
}

export const parseUsdcAmountToUnits = parseUsdc

export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS)
}

export const formatUsdcUnits = formatUsdc

export function parseUint256String(value: unknown, fieldName: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be a uint256 decimal string`)
  }
  return BigInt(value)
}

export function uintToString(value: bigint): string {
  return value.toString()
}

export function uintArrayToStrings(values: readonly bigint[]): string[] {
  return values.map((value) => value.toString())
}
