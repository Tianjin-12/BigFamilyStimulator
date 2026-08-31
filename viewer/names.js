/* 姓名访问层（薄适配）：
   起名已移至后端（真实遗传链），Person 自带 name 字段。
   本模块只提供：nameOf(id)（后端名兜底 #id）、surnameRank（在世姓氏排行）。
   旧的哈希起名逻辑已删除。 */
"use strict";

const NameEngine = (() => {
  const byId = new Map();

  function setPeople(people) {
    byId.clear();
    for (const p of people) byId.set(p.id, p);
  }

  function upsertPerson(p) {
    byId.set(p.id, p);
  }

  function nameOf(id) {
    const p = byId.get(id);
    return p && p.name ? p.name : `#${id}`;
  }

  function surnameOf(id) {
    const p = byId.get(id);
    return p && p.name ? p.name.slice(0, 1) : "?";
  }

  function surnameRank(livingIds) {
    const count = new Map();
    for (const id of livingIds) {
      const s = surnameOf(id);
      count.set(s, (count.get(s) || 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]);
  }

  // 兼容旧调用（时尚名已由后端名字池体现）
  function styleOfYear() { return ""; }

  function reset() { byId.clear(); }

  return { setPeople, upsertPerson, nameOf, surnameRank, styleOfYear, reset };
})();
