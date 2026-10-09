import { identifierVariants, queryTokenSequence } from './normalization'

/** One query word: the tokens it occupies in the index and the FTS atoms any of which satisfies it. */
interface QueryUnit {
  tokens: string[]
  atoms: string[]
}

const quote = (text: string): string => `"${text.replace(/"/g, '""')}"`

// 16.432.095 / 16,432,095 (thousands groups) and 16 432 095 (two or more space groups).
const GROUPED_NUMBER = /(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?![\d]|[.,]\d)|(?<![\d])\d{1,3}(?: \d{3}){2,}(?!\d)/gu

/** Splits digits into thousands groups from the right: 16432095 -> [16, 432, 095]. */
function thousandsGroups(digits: string): string[] {
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
  return groups
}

function buildUnits(query: string): QueryUnit[] {
  const grouped = new Set<string>()
  const joined = query.normalize('NFKC').replace(GROUPED_NUMBER, (m) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length <= 15) grouped.add(digits)
    return digits.length <= 15 ? digits : m
  })
  // Same token stream as the index would hold, with grouped amounts collapsed into one word.
  const sequence = queryTokenSequence(joined)
  const units: QueryUnit[] = []
  for (const token of sequence) {
    const isDigits = /^\d+$/.test(token)
    const wasGrouped = isDigits && grouped.has(token)
    if (isDigits && token.length <= 15 && token[0] !== '0' && (wasGrouped || token.length >= 5)) {
      // An amount is indexed as separate groups ("16 432 095") or, when typed plain, as one run.
      const groups = thousandsGroups(token)
      units.push({
        tokens: wasGrouped ? groups : [token],
        atoms: groups.length > 1 ? [quote(token), quote(groups.join(' '))] : [quote(token)],
      })
      continue
    }
    const variants = identifierVariants(token)
    units.push({ tokens: [token], atoms: variants.map(quote) })
  }
  return units
}

/**
 * FTS5 MATCH expressions for a content query, strongest first: the exact phrase, every word
 * (AND), then any word (OR). Callers run them in order and let each later stage only fill
 * the slots the earlier ones left, so multi-word queries prefer real phrase hits but a
 * query with one wrong word still finds its near matches. A single word has one stage.
 */
export function lexicalMatchPlan(query: string): string[] {
  const units = buildUnits(query)
  if (!units.length) return []
  const orExpr = [...new Set(units.flatMap((u) => u.atoms))].join(' OR ')
  if (units.length === 1) return [orExpr]
  const plan: string[] = []
  const phraseTokens = units.flatMap((u) => u.tokens)
  plan.push(quote(phraseTokens.join(' ')))
  const andUnits = [...new Map(units.map((u) => [u.atoms.join('|'), u])).values()]
  if (andUnits.length > 1) {
    plan.push(andUnits.map((u) => (u.atoms.length > 1 ? `(${u.atoms.join(' OR ')})` : u.atoms[0]!)).join(' AND '))
  }
  plan.push(orExpr)
  return [...new Set(plan)]
}
