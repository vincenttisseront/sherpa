import { describe, expect, it } from 'vitest'
import { mapLimit } from '../../server/utils/pool'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('mapLimit', () => {
  it('résultats dans l\'ordre, au plus `limit` appels simultanés', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await sleep(10 * (6 - n))
      running--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })
  it('liste vide et limite supérieure au nombre d\'éléments', async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([])
    expect(await mapLimit([1], 8, async n => n)).toEqual([1])
  })
  it('première erreur : plus rien de lancé, appels en cours terminés, erreur relancée', async () => {
    const started: number[] = []
    const finished: number[] = []
    await expect(mapLimit([1, 2, 3, 4], 2, async (n) => {
      started.push(n)
      await sleep(n === 1 ? 5 : 40)
      if (n === 1) throw new Error('échec 1')
      finished.push(n)
    })).rejects.toThrow('échec 1')
    expect(started).toEqual([1, 2])
    expect(finished).toEqual([2])
  })
})
