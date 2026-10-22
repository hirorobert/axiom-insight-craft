"""Local visual acceptance of the actual account routes, using invented HTTP responses only.
Run Vite and Chromium in one process group. Every non-local request is intercepted/aborted;
no hosted database is contacted. Requires Python Playwright and its Chromium binary.
Optional CHROMIUM_PATH points to an installed Chromium/headless-shell executable.
"""
import json,time,base64,re,subprocess,atexit,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/account-home/screens'
server=subprocess.Popen([str(ROOT/'node_modules/.bin/vite'),'--host','127.0.0.1','--port','8080'],cwd=ROOT,stdout=open('/tmp/visual-vite.log','w'),stderr=subprocess.STDOUT)
atexit.register(server.terminate)
time.sleep(2)
ref=re.search(r'VITE_SUPABASE_URL=[\"\']?https://([a-z0-9]+)\.supabase.co', (ROOT/'.env').read_text()).group(1)
uid='00000000-0000-4000-8000-000000000099'
user={'id':uid,'aud':'authenticated','role':'authenticated','email':'accountant@example.test','email_confirmed_at':'2026-01-01T00:00:00Z','app_metadata':{'provider':'email'},'user_metadata':{'display_name':'Alex Accountant'},'created_at':'2026-01-01T00:00:00Z'}
def enc(o):return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
token=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'sub':uid,'role':'authenticated','exp':int(time.time())+36000})+'.fixture'
session={'access_token':token,'refresh_token':'fixture-refresh','expires_at':int(time.time())+36000,'expires_in':36000,'token_type':'bearer','user':user}
names=['Mto Holdings Limited','Kijani Trading Limited','Harbour Public Authority','Northbank Partners','Practice Training Workspace']
statuses=['ready','needs_decision','blocked','processing','no_trial_balance']
rows=[{'engagement_id':f'00000000-0000-4000-8000-{1000+i:012d}','company_id':f'00000000-0000-4000-8000-{i:012d}','company_name':n,'company_code':f'CF-{i:03d}','company_tin':None,'period_year':2025,'period_start':'2025-01-01','period_end':'2025-12-31','currency':'TZS','purpose':'test' if i==5 else 'client','status':statuses[i-1],'upload':None,'cursor':{'name':n.lower(),'year':2025,'id':f'00000000-0000-4000-8000-{1000+i:012d}'}} for i,n in enumerate(names,1)]
# Use only statuses supported by the existing portfolio contract.
status_src=(ROOT/'src/lib/workspace/portfolioClient.ts').read_text()

state={'empty':False,'failed':False,'no_plan':False}
requests=[]
def route(r):
 u=urlparse(r.request.url)
 if u.hostname in ('127.0.0.1','localhost'):r.continue_();return
 if not u.hostname.endswith('supabase.co'):r.abort();return
 path=u.path; requests.append((r.request.method,path))
 result=[]
 if path.endswith('/auth/v1/user'):result=user
 elif '/auth/v1/token' in path:result=session
 elif path.endswith('/get_my_billing_summary'):result={'has_billing_customer':True,'plan_code':None if state['no_plan'] else 'PRACTICE','licence_status':None if state['no_plan'] else 'ACTIVE','entitlements':[]}
 elif path.endswith('/get_my_entity_capacity'):result={'determined':True,'capacity':0 if state['no_plan'] else 25,'used':0 if state['empty'] else 5,'plan_code':'PRACTICE'}
 elif path.endswith('/get_account_home'):
  es=[] if state['empty'] else [dict(engagement_id=x['engagement_id'],company_id=x['company_id'],company_name=x['company_name'],period_year=2025,opened_at='2026-01-01') for x in rows]
  result={'outcome':'ok','engagements':{'total':len(es),'rows':es},'withheld':{'total':0,'rows':[]},'companies_without_engagement':{'total':0,'rows':[]},'shared':{'total':0,'rows':[]}}
 elif path.endswith('/list_portfolio_engagements'):
  if state['failed']:r.fulfill(status=503,json={'message':'fixture connection unavailable'});return
  rs=[] if state['empty'] else rows
  args=r.request.post_data_json or {}
  if args.get('p_search'):rs=[x for x in rs if args['p_search'].lower() in x['company_name'].lower()]
  if args.get('p_statuses'):rs=[x for x in rs if x['status'] in args['p_statuses']]
  result={'outcome':'ok','rows':rs,'has_more':False,'next_cursor':None,'total':len(rs),'status_counts':{x:sum(1 for y in rs if y['status']==x) for x in statuses},'view_token':'fixture-1','limit':25,'sort':args.get('p_sort','entity')}
 elif path.endswith('/companies'):result=[{'id':x['company_id'],'reporting_framework':'ipsas_accrual' if i==2 else 'ifrs_for_smes'} for i,x in enumerate(rows)]
 elif path.endswith('/profiles'):result={'display_name':'Alex Accountant','company_name':'Accountant practice','avatar_url':None}
 elif path.endswith('/is_commercial_admin'):result=False
 r.fulfill(status=200,json=result)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox','--no-zygote','--single-process'])
 c=b.new_context(viewport={'width':1440,'height':1000})
 c.route('**/*',route)
 c.add_init_script('localStorage.setItem('+json.dumps('sb-'+ref+'-auth-token')+','+json.dumps(json.dumps(session))+')')
 page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def visit(path):page.goto('http://127.0.0.1:8080'+path);page.wait_for_timeout(1200)
 def shot(name):
  page.screenshot(path=str(OUT/(name+'.png')),full_page=True)
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'),name+' page overflow'
 visit('/dashboard')
 
 page.locator('[data-testid="portfolio-table"]').wait_for(state='visible')
 shot('01-engagements-desktop')
 page.get_by_role('button',name='Columns',exact=True).click()
 page.get_by_role('menuitemcheckbox',name='Currency',exact=True).click()
 assert page.locator('[data-testid="portfolio-table"] th').filter(has_text='Currency').count()==1
 page.get_by_role('button',name='Columns',exact=True).click()
 page.get_by_role('menuitemcheckbox',name='Latest trial balance',exact=True).click()
 assert page.locator('[data-testid="portfolio-table"] th').filter(has_text='Latest trial balance').count()==1
 page.get_by_role('button',name='Columns',exact=True).click()
 page.get_by_role('menuitemcheckbox',name='Latest trial balance',exact=True).click()
 page.get_by_role('button',name='Columns',exact=True).click()
 page.get_by_role('menuitemcheckbox',name='Currency',exact=True).click()
 page.get_by_label('Company options: Mto Holdings Limited',exact=True).first.click()
 page.get_by_role('dialog').wait_for()
 assert page.get_by_role('button',name='Record purpose',exact=True).is_disabled()
 page.keyboard.press('Escape')
 page.get_by_label('Settings menu',exact=True).click();assert page.get_by_role('menuitem',name='Plan & billing').get_attribute('href')=='/settings?section=billing';shot('02-settings-menu');page.keyboard.press('Escape')
 page.get_by_label('Account menu',exact=True).click();assert page.get_by_role('menuitem',name='Profile',exact=True).get_attribute('href')=='/settings?section=profile';assert page.locator('[data-testid="account-sign-out"]').is_visible();shot('03-profile-menu');page.keyboard.press('Escape')
 page.locator('[data-testid="portfolio-search"]').fill('Mto');page.wait_for_timeout(600)
 assert page.locator('[data-testid="portfolio-table"] tbody tr').count()==1
 page.locator('[data-testid="portfolio-search"]').fill('');page.wait_for_timeout(600)
 page.locator('[data-testid="add-company"]').click();page.locator('#fr-org').wait_for();shot('04-company-setup-desktop')
 assert page.locator('#fr-currency').get_attribute('data-value') in (None,'')
 page.get_by_role('button',name='Create company & continue').wait_for()
 assert page.get_by_role('button',name='Create company & continue').is_disabled()
 visit('/settings?section=profile');page.get_by_label('Display name',exact=True).wait_for();shot('05-settings-desktop')
 visit('/settings?section=companies');assert page.get_by_role('button',name='Companies',exact=True).get_attribute('aria-current')=='page'
 page.set_viewport_size({'width':375,'height':900})
 visit('/dashboard');page.locator('[data-testid="portfolio-cards"] li').first.wait_for();shot('06-engagements-mobile')
 page.get_by_label('Open navigation',exact=True).click();shot('07-navigation-mobile');page.keyboard.press('Escape')
 visit('/companies/new');page.locator('#fr-org').wait_for();shot('08-company-setup-mobile')
 visit('/settings?section=profile');page.get_by_label('Display name',exact=True).wait_for();shot('09-settings-mobile')
 page.set_viewport_size({'width':1440,'height':1000});state['empty']=True;visit('/dashboard');shot('10-empty-account')
 state['no_plan']=True;visit('/dashboard');page.locator('[data-testid="account-next-action"][data-kind="choose_plan"]').wait_for();assert page.locator('[data-testid="add-company"]').count()==0;shot('11-plan-required')
 state['empty']=False;state['no_plan']=False;state['failed']=True;visit('/dashboard');page.locator('[data-testid="portfolio-error"]').wait_for();shot('12-connection-error')
 assert not errors,errors
 print('ACCOUNT_LAYOUT: PASS; 12 captures; desktop/mobile; menu links; focused setup; explicit currency; search; deep links; empty/error/plan-required states; no external requests reached network.')
 b.close()
