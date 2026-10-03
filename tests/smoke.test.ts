import { expect, test } from 'vitest'
import piPermission from '../src/index'

// 外壳阶段唯一可验证的行为：入口确实是可被 pi 调用的扩展工厂函数。
test('扩展入口默认导出为工厂函数', () => {
  expect(typeof piPermission).toBe('function')
})
