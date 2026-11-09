import { h, btn, input, field, passwordInput, busy, put, errorText, toast } from '../ui.js';
const labels = { collect: '개인정보 수집·이용 (필수)', messaging: '알림 발송 업체 위탁 (선택)', overseas_ai: '해외 AI 이전 (선택)', marketing: '광고성 알림 (선택)' };
export class GuardianJoinView {
  constructor({ cloud, code = '', back, verified }) {
    this.el = h('div', {});
    const codeInput = input({value:code,placeholder:'받은 초대 코드'});
    codeInput.value = code;
    const info = h('div', {}), form = h('div', {}), error = h('div', {class:'error'});
    let checked = null;
    const check = btn('코드 확인', {onClick:()=>busy(check,async()=>{try {checked = await cloud.checkStudentInvite(codeInput.value.trim()); if(checked.role!=='guardian')throw new Error('보호자 초대 코드를 넣어 주세요.'); show();}catch(e){error.textContent=errorText(e);}})});
    const show = async () => {
      const state = await cloud.getState(), existing = state.user;
      const checkedCode = codeInput.value.trim();
      codeInput.disabled = true;
      put(info,h('p',{},`${checked.academyName} · ${checked.studentName}`));
      if(existing && existing.role!=='guardian'){put(form,h('p',{},'로그아웃하고 이 학원용 보호자 계정을 만들어 주세요.'));return;}
      const name=input({placeholder:'보호자 이름'}),username=input({placeholder:'아이디'}),pw=passwordInput(),again=passwordInput();
      const next=btn(existing?'동의 확인':'다음: 동의 확인',{onClick:()=>{
        if(!existing && pw.input.value!==again.input.value){error.textContent='비밀번호가 서로 달라요.';return;}
        const boxes={};
        const texts={collect:'학생·보호자 이름, 관계, 연락처를 자녀 연결과 학원 서비스 제공에 이용합니다. 학생 완전 삭제 시 연결 연락처와 동의 기록을 삭제합니다. 필수 항목에 동의하지 않으면 가입할 수 없습니다.',messaging:'선택한 알림의 발송을 위해 연락처와 알림 내용을 발송 업체에 위탁하는 항목입니다. 발송 업체와 세부 조건은 실제 발송 기능 도입 전에 별도 안내합니다. 현재 알림을 발송하지 않습니다.',overseas_ai:'해외 AI로 학생 정보가 이전되는 선택 항목입니다. 수신 업체·국가·이전 항목·기간·방법은 실제 AI 기능 도입 전에 별도 안내와 동의를 받습니다. 현재 이 선택으로 해외 이전을 실행하지 않습니다.',marketing:'학원 홍보·신규 반·할인 등 광고성 알림 수신 선택 항목입니다. 동의하지 않아도 기본 서비스를 쓸 수 있고 언제든 철회할 수 있습니다. 현재 광고를 발송하지 않습니다.'};
        const join=btn(existing?'이 계정에 자녀 연결':'동의하고 가입',{onClick:()=>busy(join,async()=>{try{await cloud.joinStudent({code:checkedCode,name:name.value,username:username.value,password:pw.input.value,consentVersion:checked.consentVersion,consents:Object.fromEntries(Object.entries(boxes).map(([k,v])=>[k,v.checked]))});location.hash='#/children';back();}catch(e){error.textContent=errorText(e);}})});
        put(form,h('h2',{},'보호자 동의'),h('p',{},`동의문 판: ${checked.consentVersion} · 온라인 동의는 확인 문자 발송 전까지 미확인입니다.`),...Object.entries(labels).map(([k,v])=>{boxes[k]=h('input',{type:'checkbox'});return h('div',{},h('label',{},boxes[k],v),h('p',{},texts[k]));}),join);
      }});
      put(form,...(existing?[h('p',{},`${existing.name} 계정에 연결합니다. 다른 학원 계정은 연결할 수 없습니다.`)]:[field('이름',name),field('아이디',username),field('비밀번호',pw),field('비밀번호 확인',again)]),next);
    };
    put(this.el,field('보호자 초대 코드',codeInput),check,info,form,error,btn('돌아가기',{onClick:back}));
    if(verified){checked=verified;show();}else if(code)check.click();
  }
}
export class GuardianView {
  constructor({cloud,store}) {
    this.el=h('div',{},h('h1',{},'내 자녀')); this.load(cloud,store);
  }
  async load(cloud,store){try{
    const {user}=await cloud.api('GET','/api/me');const own=await cloud.api('GET','/api/me/guardians');const {consents}=await cloud.api('GET','/api/me/consents');
    const joinCode=input({placeholder:'다른 자녀 초대 코드'});
    put(this.el,h('h1',{},'내 자녀'),...(user.children.length?user.children.map(c=>h('p',{},c.name)):[h('p',{},'연결된 자녀가 없어요')]),joinCode,btn('자녀 연결',{onClick:()=>{location.hash=`#/join?code=${encodeURIComponent(joinCode.value.trim())}`;location.reload();}}),h('h2',{},'사용할 수 있는 웹 프로그램'),...own.apps.map(a=>btn(a.name,{onClick:()=>cloud.openExternal(a.url)})),h('h2',{},'내 동의'),...consents.map(c=>{const withdraw=btn('철회',{onClick:()=>busy(withdraw,async()=>{try{await cloud.api('POST',`/api/me/consents/${c.id}/withdraw`,{});this.load(cloud,store);}catch(e){toast(errorText(e),'error');}})});return h('div',{},h('p',{},`${labels[c.item]} · ${c.version} · ${c.verified?'확인됨':'문자 확인 전'}${c.withdrawn_at?' · 철회됨':''}`),c.item!=='collect'&&!c.withdrawn_at?withdraw:null);}),h('h2',{},'비밀번호 변경'));
    const old=passwordInput(),pw=passwordInput();put(this.el,...Array.from(this.el.childNodes),field('현재 비밀번호',old),field('새 비밀번호',pw),btn('비밀번호 바꾸기',{onClick:async()=>{try{await cloud.api('PATCH','/api/me/password',{currentPassword:old.input.value,newPassword:pw.input.value});old.input.value=pw.input.value='';toast('바꿨어요.','success');}catch(e){toast(errorText(e),'error');}}}));
  }catch(e){put(this.el,h('p',{},errorText(e)));}}
}
