// Original short prose and chapter-specific assessments authored for a workflow exercise.
// This is reproducible static sample data, not a benchmark or an independent literary judgment.
export const specs = {
  premise: '# 渡口的灯\n阿宁带着母亲留下的旧灯，去停航的渡口寻找失踪的姐姐。前三章完成上船与第一次线索兑现，不提前解释姐姐失踪的全部原因。',
  world: '# 世界约定\n普通河镇，没有死者复活或瞬移。渡口停航是人做的决定。铜钱、船费与人物位置须连续。灯可以是信号，不能自行揭示幕后人的知识。',
  characters: '# 人物约定\n阿宁谨慎但会采取行动，以亲眼所见和听到的信息作判断。白伯是老船工，有独立顾虑。姐姐未正式出场，不能凭计划登记她的现状。',
  style: '# 文风约定\n第三人称限知，贴近阿宁。动作和细节推动悬念，少解释，避免凭空全知旁白。'
};
const ev = quote => ({ quote, basis: 'established' });
export const chapters = [
  {
    title: '最后一盏灯', goal: '阿宁在停航渡口获得上船的机会，留下三道缺口的谜面',
    body: `# 第一章 最后一盏灯

阿宁到渡口时，卖馄饨的摊子正在撤。老板把汤倒进沟里，白雾贴着地面走，一直走到封住栈桥的木栏下。

她把八枚铜钱摊在手里，数了两遍，又攥紧。母亲留给她的旧灯挂在腕上，灯柄有三道缺口。第一道磨得光滑，后两道却扎手。她以前总拿布缠着，今天拆了布，怕认灯的人看不清。

木栏上贴着停航的告示，纸已经受潮，最下面的日期糊成一团。阿宁认得姐姐的字。姐姐以前替渡口抄告示，那一撇总会拖到格子外。这张纸上的一撇规规矩矩。她不能凭字认出写纸的人，只能确定姐姐没有写过它。

“今晚不走。”一个声音从桥下传来。

阿宁蹲下，看见船篷里有一点红光。有人拿鞋底盖住了火盆。她不知道那人的模样，也不敢叫姐姐的名字，只把灯举过木栏。

“我来还灯。”她说。

那点红光灭了。水拍了一下桥柱，声音显得格外近。

等了一会儿，桥下的人问：“你娘让你来的？”

阿宁摇头，随即想到他看不见。“她没说让我来。她把灯交给我，是去年冬天。”

她没有接着说。母亲把灯交给她时还说过一句话：有人问缺口，你先听他怎么问。那句话在舌头底下压了一年，现在反而像别人的嘱咐。

栈桥尽头的门响了一声。“把灯留在外面，人进来。”

阿宁没有动。“人不进去，灯也不进去。”

桥下传来短促的笑声。片刻后，一只手从门缝伸出来，取下了横木。门被打开，只够一个人侧身过去。

阿宁仍在渡口。她把铜钱收进口袋，护住灯焰，走向那道窄门。`,
    intent: { participantIds: ['aning'], newEntities: [{ id: 'aning', name: '阿宁', type: 'character' }], pov: 'aning', withhold: ['不解释三道缺口用途，不揭露姐姐去向'] },
    delta: {
      characters: ['阿宁'],
      entities: [{ id: 'aning', name: '阿宁', type: 'character', aliases: [], description: '带旧灯来到渡口', evidence: ev('阿宁到渡口时，卖馄饨的摊子正在撤。') }],
      state_changes: [{ entity: 'aning', field: '位置', old_value: null, new_value: '渡口', reason: null, scope: 'world', holder: null, evidence: ev('阿宁仍在渡口。') }],
      resource_changes: [{ entity: 'aning', resource: '铜钱', opening: 0, change: 8, closing: 8, evidence: ev('她把八枚铜钱摊在手里，数了两遍，又攥紧。') }],
      narrative_events: [{ id: 'gate_opened', description: '桥下的人为阿宁打开栈桥门', story_time: '第一夜', participants: ['aning'], location: null, causes: [], scope: 'world', holder: null, evidence: ev('门被打开，只够一个人侧身过去。') }],
      foreshadow_updates: [{ id: 'lamp_notches', action: 'plant', description: '母亲留下的旧灯柄有三道缺口，母亲嘱咐先听别人怎么问', evidence: ev('母亲把灯交给她时还说过一句话：有人问缺口，你先听他怎么问。') }],
      key_events: [{ description: '阿宁拒绝把人和灯分开', evidence: ev('“人不进去，灯也不进去。”') }]
    },
    assessments: [
      ['state', '阿宁仍在渡口。', '章节末明确仍在渡口，尚未登船，不能记为已到对岸。'],
      ['resource', '她把八枚铜钱摊在手里，数了两遍，又攥紧。', '初次登记现有八枚；本章没有支付，期末八枚，不代表本章赚取八枚。'],
      ['entity', '阿宁到渡口时，卖馄饨的摊子正在撤。', '阿宁正式出场，实体描述限定为正文已经展示的带灯来到渡口；未把设定中的寻姐目的提前确立为事实。'],
      ['event', '门被打开，只够一个人侧身过去。', '开门是明确发生的动作，不能据此推出桥下人物身份或善意。'],
      ['key-event', '“人不进去，灯也不进去。”', '拒绝分开人灯是直接对话；说明记录其立场，不把台词当作已完成的登船动作。'],
      ['hook', '母亲把灯交给她时还说过一句话：有人问缺口，你先听他怎么问。', '正文保留母亲嘱咐及灯柄缺口谜面，尚未说明用途，适合 plant。']
    ],
    intentReviews: [{ id: 'goal', verdict: 'satisfied', evidenceQuotes: ['门被打开，只够一个人侧身过去。'], explanation: '争执产生上桥机会；章末只走向门，下一章仍需完成登船。' }, { id: 'withhold:0', verdict: 'satisfied', evidenceQuotes: [], explanation: '核对告示、母亲嘱咐和开门三场景，没有解释缺口用途或姐姐位置。姐姐笔迹判断只作为阿宁判断，未提取为世界事实。' }],
    notes: ['实体描述只记录带旧灯来到渡口；未出场姐姐、母亲及桥下人物不登记稳定实体。', '检查期末仍在渡口、八枚铜钱未花、缺口未兑现；阿宁只知道自己所见和母亲旧嘱咐。']
  },
  {
    title: '两枚船钱', goal: '阿宁支付船费登船，得知灯的缺口可能对应一项约定，但不把船工说法当作真相',
    body: `# 第二章 两枚船钱

窄门里面比外面暗。阿宁把灯伸过去，先照见一只带补丁的靴子，再照见抱着横木的老人。

“叫我白伯。”老人说，“别把火吹到篷上。”

他伸手拿灯，阿宁把腕子缩回去。老人没再要，只用横木指了指系在桥柱上的小船。

“过河两枚。回程另算。”

阿宁从八枚铜钱里付出两枚，口袋里还剩六枚。白伯没有把钱揣起来，先放在桥柱顶上，等她踩稳船板，才收进袖子。

船离开桥柱，阿宁坐在渡船的船头。她用手撑着船沿，直到水上的告示牌缩成一块灰色，才敢把两条腿都收进去。

“灯给我看看。”白伯说。

阿宁问：“你先说看哪里。”

老人盯着她片刻，叹了口气。“你娘真会留麻烦。看柄，不看火。”

她把灯柄转向他，自己的拇指仍压在第一道缺口上。白伯没有碰灯。

“三道缺口，三次问话。到对岸，先别急着说第三句。”白伯告诉她。

阿宁听见了这句话，却不知道三次问话是谁定的。她想起母亲让她先听别人怎么问，觉得两句话能接上，又不敢把这点相似当成凭据。

“第三句是什么？”

“你问我，已经是第四句了。”

白伯背过去撑篙。那句话像个玩笑，他的肩膀却一直绷着。

阿宁望向对岸。那里有几间看不出窗户的房子，只有石阶下亮着一盏小灯。她把自己的灯提高，小灯便矮下去，过一会儿又升回原处。可能是风，也可能有人在提它。她只能看见光，不能看见人。

“别答应得太快。”白伯低声说。

船底擦到什么，停了一瞬。白伯把篙抬起，篙尖缠着半幅蓝布。阿宁认得颜色，姐姐常穿蓝衣，可河镇穿蓝衣的人很多。她攥紧灯柄，没有喊。`,
    intent: { participantIds: ['aning', 'bai'], newEntities: [{ id: 'bai', name: '白伯', type: 'character' }], pov: 'aning', requiredState: [{ entity: 'aning', fields: ['位置'] }], requiredResources: [{ entity: 'aning', resource: '铜钱' }], requiredEvents: ['gate_opened'], requiredHooks: ['lamp_notches'], knowledgeChecks: [{ holder: 'aning', topic: '三道缺口' }], withhold: ['蓝布不证明姐姐出事，不揭露对岸提灯人身份'] },
    delta: {
      characters: ['阿宁', '白伯'],
      entities: [{ id: 'bai', name: '白伯', type: 'character', aliases: [], description: '向阿宁收船钱的老人', evidence: ev('“叫我白伯。”老人说，“别把火吹到篷上。”') }],
      state_changes: [{ entity: 'aning', field: '位置', old_value: '渡口', new_value: '渡船', reason: '登船过河', scope: 'world', holder: null, evidence: ev('船离开桥柱，阿宁坐在渡船的船头。') }],
      resource_changes: [{ entity: 'aning', resource: '铜钱', opening: 8, change: -2, closing: 6, evidence: ev('阿宁从八枚铜钱里付出两枚，口袋里还剩六枚。') }],
      facts: [{ subject: '三道缺口', predicate: '船工解释', object: '三次问话；到对岸先别急说第三句', scope: 'belief', holder: 'aning', evidence: { quote: '“三道缺口，三次问话。到对岸，先别急着说第三句。”白伯告诉她。', basis: 'reported' } }],
      narrative_events: [{ id: 'boarding', description: '阿宁乘白伯的船离开渡口', story_time: '第一夜', participants: ['aning','bai'], location: null, causes: ['gate_opened'], scope: 'world', holder: null, evidence: ev('船离开桥柱，阿宁坐在渡船的船头。') }],
      foreshadow_updates: [{ id: 'lamp_notches', action: 'advance', description: '白伯把缺口解释为问话次数，阿宁尚未证实', evidence: ev('阿宁听见了这句话，却不知道三次问话是谁定的。') }],
      key_events: [{ description: '阿宁听白伯解释缺口但保留怀疑', evidence: ev('她想起母亲让她先听别人怎么问，觉得两句话能接上，又不敢把这点相似当成凭据。') }]
    },
    assessments: [
      ['state','船离开桥柱，阿宁坐在渡船的船头。','离桥并在船内，旧位置渡口匹配；未到对岸。'],
      ['resource','阿宁从八枚铜钱里付出两枚，口袋里还剩六枚。','明确八减二等于六，与第一章期末八枚一致。'],
      ['entity','“叫我白伯。”老人说，“别把火吹到篷上。”','人物自称白伯，作为登场名称；没有宣称他的真实身份已被证实。'],
      ['event','船离开桥柱，阿宁坐在渡船的船头。','登船离桥确立，前章开门提供前置机会；不推出彼岸抵达。'],
      ['key-event','她想起母亲让她先听别人怎么问，觉得两句话能接上，又不敢把这点相似当成凭据。','写明听后仍怀疑，是角色的反应；船工解释作为 reported belief 单独记录。'],
      ['hook','阿宁听见了这句话，却不知道三次问话是谁定的。','新增缺口解释但未验真，推进而不是兑现。']
    ],
    intentReviews: [{ id:'goal',verdict:'satisfied',evidenceQuotes:['阿宁从八枚铜钱里付出两枚，口袋里还剩六枚。'],explanation:'支付和登船完成，世界位置、余额变化有原文；解释只作为阿宁听到的说法。' },{ id:'knowledge:0',verdict:'satisfied',evidenceQuotes:['“三道缺口，三次问话。到对岸，先别急着说第三句。”白伯告诉她。'],explanation:'信息通过当场听白伯说话获得；初始没有登记认知，已读上章原文确认她此前只知道母亲嘱咐，不知道用途。' },{ id:'withhold:0',verdict:'satisfied',evidenceQuotes:['可河镇穿蓝衣的人很多。'],explanation:'蓝布仅触发联想，未确立姐姐遭遇；提灯人仅见光，身份没有揭露。' }],
    notes: ['逐项读台词和动作，船工解释只入 belief；蓝布和对岸人身份不提取世界结论。', '前章门已开；本章登船、付二枚剩六枚；缺口只推进，视角没有跨到白伯内心。']
  },
  {
    title: '第三句话', goal: '在对岸用缺口完成一次问答信号，兑现缺口用途，开启姐姐留下字条的新悬念',
    body: `# 第三章 第三句话

蓝布落回水里。白伯没有解释，阿宁也没有问。船又走了一段，篙尖终于碰到石头。

白伯把船系在石阶旁。阿宁从渡船上岸，到了对岸石阶。她摸了摸口袋，六枚铜钱还在，边缘硌着手心。

另一盏灯摆在第二级石阶上，提灯的人藏在门里。阿宁把自己的灯放在第一级，没有伸手去拿上面那盏。

门里问：“从哪边来的？”

“河这边。”阿宁答完便后悔。这边是哪边，要看站着的人。

“带什么来的？”

“一盏旧灯。”

第三句话没有立刻来。门里的人咳嗽了一声，灯焰晃了晃。阿宁想起白伯说不要急着说第三句，把已经张开的嘴闭上了。

“灯留下，你走。”

她的拇指从灯柄第一道缺口移到第二道，再移到第三道。三次问话。前两次要答，第三次也许恰好不能答。母亲没有教过这个“也许”，白伯也没有把话说完。她只能自己选。

阿宁没有照那人的话走。她提起旧灯，把灯柄三道缺口对着门缝，始终没有回答。

门里的灯慢慢矮下去。这一回没有升起来。

“你娘记性真好。”里面的人说。

阿宁听见铁链被抽走的声音。门开了半扇，地上露出一张纸，压纸的是个破茶碗。

“她说，如果有人提这盏灯来，听完三句还不肯交灯，就把纸给那个人。”门里的人说。

阿宁这才明白，灯柄的三道缺口不是要她说三句话，而是提醒她等三句说完，再决定把灯交给谁。门里的人照约放出了纸。这是她今晚第一次看见那套说法真的起作用。

纸上写着：别找渡口，找停航那一天的船。字的最后一撇拖出了边。

阿宁蹲下拿纸，却没有进门。那一撇很像姐姐，她还要找更多凭据。她回头望白伯。老人站在船上，手里的篙已经横过来，挡住了他和灯之间的光。`,
    intent: { participantIds:['aning','bai'], pov:'aning', requiredState:[{entity:'aning',fields:['位置']}],requiredResources:[{entity:'aning',resource:'铜钱'}],requiredEvents:['boarding'],requiredHooks:['lamp_notches'],knowledgeChecks:[{holder:'aning',topic:'三道缺口'}],withhold:['不确认字条作者，不解释姐姐失踪全部原因'] },
    delta: {
      characters:['阿宁','白伯'],
      state_changes:[{entity:'aning',field:'位置',old_value:'渡船',new_value:'对岸石阶',reason:'船靠岸后上岸',scope:'world',holder:null,evidence:ev('阿宁从渡船上岸，到了对岸石阶。')}],
      facts:[{subject:'三道缺口',predicate:'本次信号用途',object:'本次门内约定提醒持灯人等三句话说完再决定是否交灯',scope:'world',holder:null,evidence:ev('灯柄的三道缺口不是要她说三句话，而是提醒她等三句说完，再决定把灯交给谁。')},{subject:'三道缺口',predicate:'阿宁认识',object:'提醒自己等三句说完再决定交灯',scope:'belief',holder:'aning',evidence:ev('阿宁这才明白，灯柄的三道缺口不是要她说三句话，而是提醒她等三句说完，再决定把灯交给谁。')}],
      narrative_events:[{id:'note_received',description:'阿宁拒绝交灯后获得门里放出的字条',story_time:'第一夜',participants:['aning'],location:null,causes:['boarding'],scope:'world',holder:null,evidence:ev('阿宁蹲下拿纸，却没有进门。')}],
      key_events:[{description:'阿宁读到寻找停航当天船的提示但没有确认作者',evidence:ev('纸上写着：别找渡口，找停航那一天的船。')}],
      foreshadow_updates:[{id:'lamp_notches',action:'resolve',description:'三道缺口的问答信号使阿宁取得字条',evidence:ev('门里的人照约放出了纸。这是她今晚第一次看见那套说法真的起作用。')},{id:'stopped_boat',action:'plant',description:'字条要求找停航当天的船，作者和船仍未知',evidence:ev('纸上写着：别找渡口，找停航那一天的船。')}]
    },
    assessments:[
      ['fact','灯柄的三道缺口不是要她说三句话，而是提醒她等三句说完，再决定把灯交给谁。','不仅有阿宁理解：前文三问、她不交灯、实际放纸的动作验证了本次约定用途；不推广为适用于所有持灯人的万能规则。'],
      ['state','阿宁从渡船上岸，到了对岸石阶。','上岸确立位置变化，旧位置渡船匹配；没有进入门内。'],
      ['event','阿宁蹲下拿纸，却没有进门。','明确拿纸的动作结合此前门里放纸，支持获取字条；没有进入门内，门里人身份仍不知。'],
      ['key-event','纸上写着：别找渡口，找停航那一天的船。','仅记录字条存在和文字，不确立字条来源或提示真实。'],
      ['hook','门里的人照约放出了纸。这是她今晚第一次看见那套说法真的起作用。','三问后拒绝交灯得到纸，缺口的信号用途获本次动作验证，旧承诺可以 resolve。'],
      ['hook','纸上写着：别找渡口，找停航那一天的船。','新的船线索尚未调查，另立稳定 hook，不把找船作为已发生事件。']
    ],
    intentReviews:[{id:'goal',verdict:'satisfied',evidenceQuotes:['门里的人照约放出了纸。这是她今晚第一次看见那套说法真的起作用。'],explanation:'完成问答、拒绝交灯和拿纸；旧缺口承诺兑现，新字条线索留给下一剧情段。'},{id:'knowledge:0',verdict:'satisfied',evidenceQuotes:['第三次也许恰好不能答。','阿宁这才明白，灯柄的三道缺口不是要她说三句话，而是提醒她等三句说完，再决定把灯交给谁。'],explanation:'先根据白伯说法提出未确定猜测，看到门内执行放纸后才更新认知；没有提前知道答案。'},{id:'withhold:0',verdict:'satisfied',evidenceQuotes:['那一撇很像姐姐，她还要找更多凭据。'],explanation:'纸条笔迹仍需核对，字条作者和姐姐去向没有被确立；本章只闭合信号线索。'}],
    notes:['先读上一章已登记船费和角色认知，核对位置由渡船到石阶、六枚不变；无资源变化不额外创建交易。','门内人物未清晰登场，不凭声音登记姓名；字条作者未确立；缺口兑现与新的船线索分开记录。']
  }
];
