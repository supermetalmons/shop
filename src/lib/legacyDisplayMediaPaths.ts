import { canonicalizeDropAssetUrl } from '../config/deployment.ts';
import {
  CARD_NFT_2_CDN_BASE_URL,
  CARD_NFT_2_PACK_BASE_URL,
  LITTLE_SWAG_BOXES_CDN_BASE_URL,
  LITTLE_SWAG_HOODIE_IMAGE_BASE_URL,
  PONCHO_DRIFELLA_CDN_BASE_URL,
} from '../config/dropMediaDefaults.ts';
import { CARD_NFT_2_ASSET_CDN_BASES } from './cardNft2Assets.ts';

type LegacyAssetsMonsDisplayMediaMapping = {
  prefix: string;
  baseUrl: string;
};

type LegacyIpfsDisplayMediaGroup = {
  baseUrl: string;
  cids: readonly string[];
};

const DISPLAY_MEDIA_PATH_RE = /\.(?:gif|jpe?g|mov|mp4|png|webm|webp)$/i;
const DISPLAY_MEDIA_URL_RE = /\.(?:gif|jpe?g|mov|mp4|png|webm|webp)(?:\/+)?(?:[?#]|$)/i;
const IPFS_PROTOCOL_RE = /^ipfs:\/\//i;
const IPFS_GATEWAY_PATH_RE = /\/ipfs\//i;
const IPFS_GATEWAY_HOST_RE = /\.ipfs\./i;
const KNOWN_CDN_URL_PREFIX = 'https://cdn.lil.org/';

const CARD_NFT_2_FRONT_CDN_BASE_URL = `${CARD_NFT_2_CDN_BASE_URL}/fronts`;
const CARD_NFT_2_VIDEO_CDN_BASE_URL = `${CARD_NFT_2_CDN_BASE_URL}/videos`;
const PONCHO_DRIFELLA_RECEIPTS_VIDEO_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/receipts_videos`;
const PONCHO_DRIFELLA_VIDEO_CDN_BASE_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/videos`;

const LEGACY_ASSETS_MONS_DISPLAY_MEDIA_MAPPINGS: readonly LegacyAssetsMonsDisplayMediaMapping[] = [
  { prefix: '/drops/cardnft2/img/', baseUrl: CARD_NFT_2_PACK_BASE_URL },
  { prefix: '/drops/lsb/', baseUrl: LITTLE_SWAG_BOXES_CDN_BASE_URL },
  { prefix: '/drops/poncho/', baseUrl: PONCHO_DRIFELLA_CDN_BASE_URL },
] as const;

const CARD_NFT_2_FRONT_IPFS_CIDS = [
  'bafybeicx2kqodx3nnblul52ea3eb2oj6t23yczsemoscbvoo5c3jh7bg6u',
  'bafybeied2ho6ufy7piamk5vb722shwn7xdghnrjwfg5skd2wjuakyt2qee',
  'bafybeihex755a5p6fvnjyzs2y3ys7g26lcb7pgtmehlwtvoiil3f36geae',
  'bafybeigqprwlag7hp2ajha5hogncobfacvolq75vuldfvzph5nbl5dvuly',
  'bafybeibyvazmohb57zwhy2gebyf33r6avwwwffoaiun2iurxsj6zyx3pti',
  'bafybeiffeeapteodxmxefv7xudw75ik6ivsy3no7cxv4juh53p6z553l7u',
  'bafybeighnc3w7uveh72dc3odlqet2lsktygbeq25jm3ihz5vs7qdeh7qny',
  'bafybeia2iwpp6w5p4feuj3hcz77yxnjstbs72batrlreh3te3nfijg5t6m',
  'bafybeie6mtlcm64rebvyxy2ti5k56d7xzib5icbsrdszu4dr6q65hrwlqy',
  'bafybeifw3molqn5qxqagvukpbz7pc3i6zvam5rhnivxkcjnz624qolmapm',
  'bafybeicm5qpir3byulfvqcvqbjbzxf2p4ywgpbsjjrbjjwthvfzyxudrdm',
  'bafybeifqwpf6tjcsrxfenlsahbxu7ed7p3xeq5ahssqjipbflu6oxeqdj4',
  'bafybeid7n63yttnwkzlzpl5llr4vrswe4775w5iakbji3grhuspkf34xnu',
  'bafybeicdp3lnoq6tekykwu3ersidp3pehizxrawrcnv7zsquprzzuxfon4',
  'bafybeibu5gqltrq7vgadlbdhnkbipw5h67wpibahuxkji5ms34skwjck3u',
  'bafybeiclmefv3lxnzboxl4i6y2he6ndktvgu73gtfdar4obmirkwxjyaru',
  'bafybeibphhz6b6yns732encfaygpdtajai2t6qsndqcd6exwetctfje2gi',
  'bafybeiezcnn2v4yejvnk2wier44rnph5pixyqdzai5hqyz2fy56jqamski',
  'bafybeihulauq2dye267wryrovyiaodcrr7hlkda43vm3h4rzoplt2k2era',
  'bafybeidektdd6w5e5fxefvcf3hfifahm4izystdx3sfb6rgmz5olfufqai',
  'bafybeian7gokms5otvdghnnkhol75laxras7ya2la2lnl7dclavav66jbe',
  'bafybeidjq6mek3abssb5stps24fszq3d5kaefafhhi43e2jfsbbx3kkuvm',
  'bafybeieptgn4wwcc4wj4mtwmkb6o3i466ef5fyelzwuu7wqf7itnzvvu6u',
  'bafybeiblouvhgvbkgwpfn7u4ppjnw7elqpnscjp2acgw5qwklaq4espimi',
  'bafybeid4bsmknigw4uuufe2ffowzkmy5jyndppx7rnoo54rj7mqducu2t4',
  'bafybeibyfj2h4z4squwycc3x2msbwrqfanp2ye7t3btpjtuq6cm5xyb5my',
  'bafybeigdadtnipceyx43hllkobnxrhuuzw47a4bz4zgwedclctaeebmgli',
  'bafybeibr6jhx62mp5lslsgwkyrjvtgqjkptnjw5c6za4vjz3elfs2i5lle',
  'bafybeif2ptphyh23segjtxwjugvgg526v5dsikh2cokrj6z4sgwobjluw4',
  'bafybeifmguwjx77lsrj44xedzn6skjekobhskq2eaafgrbwgeyhn7i2lle',
  'bafybeif6zlxygsn56tztej3axlxofrxljfqozuwj5ftebre6twql3i2cvm',
  'bafybeie7dziaiqzznwha7rsoyiwnsxgnsu6r5nv42v5fhrczuzeazxls2y',
  'bafybeicaqr3i3xrvkk3fi2rb57xdu6h5jplxtrw6aisnb5p6q5fbnai3wa',
  'bafybeif3stuovnnpalxe6iq7pvyb5xb6rmcrsolg444563zxhppbnu4ghi',
  'bafybeihyvns4cb36cxa6u6smeiwtqs6sqpe7n2pzczfyba4vy2fcws2tty',
  'bafybeic632o6jxz5ngnqpwfei57csob2tiqkokww77jofxgzv5dj5ehwl4',
  'bafybeifiq2wc5vglm7mm4lnvgflhho56yk6yvkjwkv7vxvyqfzzwplhk3i',
  'bafybeibmbfz4zxsezcziuztm5puzyakg4redntnf4rkexm2opsox4mrji4',
  'bafybeifdj2bya2kynsfzclwkj6ha2rthtxcw63rich5tijjpqubgdxzd7e',
  'bafybeigif6folmyvk2jd4ruq7c3gdkasuaul2d4zopcw6csi3ruufpxk2a',
  'bafybeid2t7l42pngygtv4fl3eahtnyjv74jhyu352gt4orcgjntjilyswu',
  'bafybeici7qtpcvoudxn4fkjezphkqvjskionyczibn6tplbe4tg7xwqzvu',
  'bafybeia442wiuf5tam3juffmwcaburgklgnxgtufi3x5zhlso6xrzdrnfa',
  'bafybeighfbk6mr6pxuqdhsj25o4ixyt4mnd46wwzc76i52umg3loquge7a',
  'bafybeieowtnhfagery4tfixpb4mcmelvpcwyxdli2223qt6uquu2p677wa',
  'bafybeih2ji245tjfp4mli5fuu2ftr7anbxm7ksbia5lp5y53sqc3eehpqa',
  'bafybeihf43cnm2k2pldogvf4tqpbzcqiktdtqyipqohgq67irhg3w6p3zq',
  'bafybeih3tu5424bpicnfy7s4jtptnrywpdmovdsgewvhjtrddxszvadvai',
  'bafybeid5ka4bsnkofsilze7x7zxpqkrnegjn7p4ix4hrh2mzfyhpifhfvy',
  'bafybeie7bxsbzvwqh2ucbuwnsghatkzhpkanlciyobag4da334x7wqbyxy',
  'bafybeihhorf7achpzcmmlnd7zxlnjy3ujni5ysgopmfrz6a3ep2gwwe5hu',
  'bafybeih4sksazasq2ad4umw2uqynu5zx5peax4jju5lccdp4t4nbkguqsa',
  'bafybeiacvd5gagu2k54izq57p5bmhtaksfceiw7yb7256q7xvydxujhuoi',
  'bafybeibwrbd6cfv6er64w3ul5ecb5gx56hxmowtr6ettbug2iomckgchce',
  'bafybeiaf5uq5hcirny63wmf4qwk5tb5cg5lw3n3jtnhfzk2tmwkdc4nd6i',
  'bafybeihk2q2dq3ao3n227efwufm3dvtjghuuqimjsm3lp7vkwnzs5nxv4m',
  'bafybeiahkmb4zdcnlhzfwwfknbk6mmb5y2vz4sfdnw6qvp3ptzcnoh7jxa',
  'bafybeif7oz7uncjzjavsa3po4xvh6pe3glr4uryimskuqeuwf5bpau5vpi',
  'bafybeidemq4xk7sny5ruuhttqwqtkrozyq47qd7ftt3kk66prhfghf6d5a',
  'bafybeibdh5rsaiduwjrftbisgbxzslesng7rlqx2nbv7eef34vcstf3tty',
  'bafybeiek3jlgnfhxx4zxzye7zswej4pvoef5jzpx4nptdah6umjcdiqssy',
  'bafybeiftscuas7ulj5q4xjsjrz6abgoyj7fud5ygc7thnu6fyptrtasxwq',
  'bafybeifbprieqyql72vqdaextuwnalbdctxvuitkntztyq5u7tbba45j3i',
  'bafybeibhzn4dma6gtr25arbknrutu7kgtwaghtstb6mc3obt26wuukxtey',
  'bafybeigzcjihmhtskfnffbvcjdiq6gtwsd3cthnzawbacxz3a52vrcmvbi',
  'bafybeih7johvbbcki4gs2nao76gnw2mdvff764uqyepz67yo36342cnwoi',
  'bafybeid4ij4a6kj3fhnn37n3l2uu2uq5bsxzd42ptenllmokhd3ou75ytm',
  'bafybeifq7golvxs7rlmsarcicf7ckqff4r4ouddp5fcd6s7ieci2kf4tkm',
  'bafybeigobdzqbj3nggsqmkfmitmnutg7xtijguqdlba5ln6ehk3hcra3py',
  'bafybeicadrsl7ghmkwtxhaw2ukleoiu3curtia7cbcdyekwqrij34wrx3y',
  'bafybeif3awiy2avzqgf5pkw7myuep4n3g65bsp6j2n6ut7gcrgwafejelu',
  'bafybeibh7bcrvp7uhwclrdwetytvbarkyy3cmcgzpbeneisjy7p467bbri',
  'bafybeiblcwveznvbeslpxdx4ostwysgdv3cvvokjs4vaisch2sw4c7r4ja',
  'bafybeiejy4gsu6v4zmfn4ymr26uokzkvigotieqqigahgboracew6bfxcu',
  'bafybeiaa6jz2b5vxzjkihf6zeo4fokn4xja3sqhsggqm5asibcbdts65vm',
  'bafybeicrcwia5xftn6kv7lssaa7apmlfe7kzxkdjuqitefw4362qq3kkmy',
  'bafybeigswnwreuoxpvv5vln2d4ekdfvu72yc6pnb5splfc5royvvxqbmmi',
  'bafybeifhz3gfhwq7b3aslghzmiy5hrrbwqz3gfkxar6btew5vrxl2e2ipu',
  'bafybeihkns5l3ianwsf3h4vsejavtwqkazf2z5veke6qg2ac3cszdy2y4q',
  'bafybeif4q2nbe4gx3rmosa4bqxcosvhnwv6f3lmdzmqmkgnxxlf4ipn3em',
  'bafybeibbo2fajlxsdmfhkhmlgzskrstdjhkd2t4cxfd2ekwrpa65b63td4',
  'bafybeicng6dk4sm4ohkqygq7nwgm7j7b3nkkh5wr2c5rybqblxjdzer2wq',
  'bafybeicyidjumhov6lcyfr5tzjcheehrnmoo734waxdwvz3jltws6f53p4',
  'bafybeifw34vttin375k7vjn5jx6gtgw5hs5mnabt6nln52xhv5alrg3iam',
  'bafybeierisp4u6g72ailsoi7oxhbhb4ozetsmutlmwjpffsbm5qjea32dm',
  'bafybeic3amzsh44ft55esvi42tvtqobz7zhj4hyfr63wvrrqbn5mkxfyua',
  'bafybeidiy62oge7xblkcv72eki7xim7aegdofcj3mvcx3vqkbdq2pc5a7a',
  'bafybeibpskolnfr3ecbrivn5t4yj7rltjt6hn3cjelbxkjmynsumfgfa5m',
  'bafybeicvvet5axcck3btko3armxvvkrancti35gnpuhad6hriys32gjyrm',
  'bafybeicdae4lypnnkpzlvypbza5myhorhp2rjkwxirbe3f7dmcvpjnqjki',
  'bafybeibh4n4r36vfmfgryptoaf6vtuagd3f2nb74vlaambauh2brxbjkvm',
  'bafybeiahehcej5zfyrs7fz2hxpq2yudyingyculygj3d7jsxc2kz6rmv24',
  'bafybeieb5hyhixvpsxdydnvgfbbnuu6u3u7j2x6yfhbebdqriks44wfgom',
  'bafybeidhvyy3fx24wrvmb65kqwry4lh6pnh7m4mms626fe7pbm5gxc6i4a',
  'bafybeicggkx3wp6lbmpkyb5352uszd45dfyo2tvfmi75jw4ypoi34oyepu',
  'bafybeiblvlezmhgmclcprnngji3qsz3nt6u4aze2skuhtwua3f4m4b5h3m',
  'bafybeigtneeogsk76azev2r2icgw4t4kj2d4yklncsjaqy5nyvglre3lqe',
  'bafybeibqq5g2n6mwuxrptinj3oekm3lhj7droiixvk4yuv72gz5xjnlhyq',
  'bafybeievt2ofytqbhowbjbbucc6z22v4hnm5svp2x46upn3mcp3vrnydfa',
  'bafybeigjz52572pxc7lvx6m4ygqvnnhb7nijgyn2barngwp4bkasgogl5i',
  'bafybeihisvwwcwcpz6qu7pfbepva63myqv53xgpemrsanjnqdylxge5koq',
  'bafybeicttnaubgex6mle5zbtcsokt5bd56d5qre23ebdldkuybpltzjsmm',
  'bafybeich74tloszkcfakhe5mjkfmh2k5li3ihewut74t3mnopvxxei3pl4',
  'bafybeie7rsofkjsh6gfhx7j4mknxzj5azhwwllxrxaogqigphp76nptare',
  'bafybeibg4gs3hm6syjhjjskmdzsqnomwybg6mjaskyg72tgouhexfsks44',
  'bafybeifygvwipivm43tycfkq2sfwrkmgaweoypkg2vvgalxn5p4lvymsoa',
  'bafybeigcp3katzj4oap7u7guoft3eecpvv5s36bkaet762cseoq3exfdxm',
  'bafybeidzktygju3dkptzrruolf74dej427shwo4tbka6zjd2jdx64suhwe',
  'bafybeiafpcijzwz44xfokdzc2xaq7eeqzlfhgymyc6i4ysbqt3236b4v4e',
  'bafybeici6fvht7adhnhzv3mmr5lbtwgbnpdvxykx5jkhoe2bcxp6x2pcri',
  'bafybeiahwyibylvpo5z27a4f3e4qolhyhxsbcyolia7rsnxu45gf3nky7e',
  'bafybeia4tiw6n2omz3vhncab5nsj5euycga33hw4wt553loqgee3n3azji',
] as const;

const CARD_NFT_2_VIDEO_IPFS_CIDS = [
  'bafybeibyekgydzallz3fy4mdmpi72mht2kxaglvdu5cfdc54lzhqbdcnqi',
  'bafybeib3skhubfztqukqzvzsrs7yol5n2lrik5g54okseojgbddloevwg4',
  'bafybeihsj6kimhcnwenwjvrv4boeatb4amiyqwcb5qmneenl5fyafclrj4',
  'bafybeihobalo7vf2arlvfbccslso3tw67moi5277gwxlb3rjkeltgwmi2u',
  'bafybeidqndohy4ijra77tmepk4xk5g4eptjh5n7y4kcjyxsdzoi5ilioyi',
  'bafybeic2hijsppaifjivq64fr3fvjudvs2yu4m2eddr6csb7rpwjewk63u',
  'bafybeidhrnedvbxai5gvt2gib7yia4in2zd5kejdgwh4ru5ojhhevnemwm',
  'bafybeig3moqrlsf2fjp5mk3f2s2xjzzon27wadeemlczanwqiwygwrj3hi',
  'bafybeicu3kx3qyduiqjoahtixzredqrbafirrdc25is6nbeyn7rf632s7i',
  'bafybeidd5w3iqhii3pmfcuvd2tppdm66357l6alv67rzzybjbkb632lopu',
  'bafybeibwjaiegufqfulwbl2gtorcvkwko6zqfqdmqxqjj7qy7d4nzxeitu',
  'bafybeif4onolcq72dyhonpveqkgkjnmsn66ylhksg5o7s44e4uulgccgtm',
  'bafybeiay656kzz7siqjs3mj72cnqogmuyx6dhnd5mjyvl4qv6j6t6wndla',
  'bafybeie3w73nni22wxvdiqh5dtgeo6sbno6uro72kbgnuyfg7jhtgfexqe',
  'bafybeihwvz3uqf6z42rpoy25poqcltebqy6q72wfqzfudchnqc77oyp7he',
  'bafybeih7iiffjgacvysr6qz3bnu5qdgjatkrzv7mjb4v2c4rx4hr26mng4',
  'bafybeialiokg4jxtsricmyo5fqwwjwqi3iyyn4lgewrn6f3ob5a57nirsu',
  'bafybeigrbv2m5rd5woa3z3d6inninejrdq6jv2uebf2ljh7rwnp35wycta',
  'bafybeieu36buwaon4nvn7yhdtv6b3ccll7azoltw27yarhmesxh45ipg4y',
  'bafybeifnlnzlumsmo5q7ih62vvcqd5dcrit3obopr2cqzaogohnhd3n2ne',
  'bafybeifn3cmltebaf7szh2vug5l4lolya4swy5yriew43dy63basi3nyfu',
  'bafybeid5r5gupb4okx4apyffhzb45exniagdrshxevr24g7jmmbcroozga',
  'bafybeiffrcg6tu6c3aesnre25oaqiabhx4unznkdpuuk6mccfpwgu4i5pm',
  'bafybeifkxuelzuehfohj5jf4jzp2sgliz5wb7fvzw4nphj5cd3x2gspiqm',
  'bafybeighb3hwybu6pb3kfqzm4gst7gal7gszdc4yvv7tkyujvsacasn2ku',
  'bafybeidi3fiviusy6y6u6zuz3xwskk3r3p7rxvlcspkjhu6jfb7tfuorcy',
] as const;

const LEGACY_IPFS_DISPLAY_MEDIA_GROUPS: readonly LegacyIpfsDisplayMediaGroup[] = [
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.img, cids: ['bafybeib7tmlzh7tcolyurmbm2p7vcv5pcqdcbiaqyx2c2handx3y2ilpaq'] },
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.mask, cids: ['bafybeiapwcv66aqu2wzh3f5mp4j4j6h7zej3no7paae4qcqxpu3mg436ia'] },
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.foil, cids: ['bafybeigzyk3qd7brxfd3uinftdywhwao65gdxuleqirv5zje3okftmxczy'] },
  { baseUrl: CARD_NFT_2_ASSET_CDN_BASES.receipt, cids: ['bafybeif3ydbiydtyj6b3eonlzvmz3esojlfsvwcb3bynlwjg6vtbwvangq'] },
  { baseUrl: CARD_NFT_2_FRONT_CDN_BASE_URL, cids: CARD_NFT_2_FRONT_IPFS_CIDS },
  { baseUrl: CARD_NFT_2_VIDEO_CDN_BASE_URL, cids: CARD_NFT_2_VIDEO_IPFS_CIDS },
  { baseUrl: LITTLE_SWAG_HOODIE_IMAGE_BASE_URL, cids: ['bafybeiaka2o45fhcmufpvthgp53xslhnblmqzeg4dri2rqozd7yqndjck4'] },
  { baseUrl: PONCHO_DRIFELLA_RECEIPTS_VIDEO_CDN_BASE_URL, cids: ['bafybeiamzyimzf77yvlmz5qevbk2looxjmmswyjxzvxqdnooihuderjvkq'] },
  { baseUrl: PONCHO_DRIFELLA_VIDEO_CDN_BASE_URL, cids: ['bafybeihhtllco3nhn2vau3ezqu7zpzfjij4x7n7tcxz63k6fkq55jljram'] },
] as const;

const LEGACY_IPFS_DISPLAY_MEDIA_BASE_BY_CID = new Map(
  LEGACY_IPFS_DISPLAY_MEDIA_GROUPS.flatMap((group) => group.cids.map((cid) => [cid, group.baseUrl] as const)),
);

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isDisplayMediaPath(path: string): boolean {
  return DISPLAY_MEDIA_PATH_RE.test(path);
}

function isLegacyDisplayMediaCandidate(url: string): boolean {
  if (!DISPLAY_MEDIA_URL_RE.test(url)) return false;
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.includes('assets.mons.link') ||
    IPFS_PROTOCOL_RE.test(lowerUrl) ||
    IPFS_GATEWAY_PATH_RE.test(lowerUrl) ||
    IPFS_GATEWAY_HOST_RE.test(lowerUrl)
  );
}

function joinDisplayMediaUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
}

function rewriteAssetsMonsDisplayMediaUrl(url: string): string | undefined {
  if (!url.toLowerCase().includes('assets.mons.link')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== 'assets.mons.link') return undefined;
  if (!isDisplayMediaPath(parsed.pathname)) return undefined;

  const found = LEGACY_ASSETS_MONS_DISPLAY_MEDIA_MAPPINGS.find((mapping) =>
    parsed.pathname.startsWith(mapping.prefix),
  );
  if (!found) return undefined;
  const rewritten = joinDisplayMediaUrl(found.baseUrl, parsed.pathname.slice(found.prefix.length));
  return `${rewritten}${parsed.search}${parsed.hash}`;
}

function rewriteIpfsDisplayMediaUrl(url: string): string | undefined {
  const lowerUrl = url.toLowerCase();
  if (!IPFS_PROTOCOL_RE.test(lowerUrl) && !IPFS_GATEWAY_PATH_RE.test(lowerUrl) && !IPFS_GATEWAY_HOST_RE.test(lowerUrl)) {
    return undefined;
  }
  const canonical = canonicalizeDropAssetUrl(url);
  const match = canonical.match(/^ipfs:\/\/([^/?#]+)\/([^?#]+)([?#].*)?$/i);
  if (!match?.[1] || !match[2]) return undefined;

  const cid = match[1].toLowerCase();
  const mediaPath = match[2];
  if (!isDisplayMediaPath(mediaPath)) return undefined;

  const baseUrl = LEGACY_IPFS_DISPLAY_MEDIA_BASE_BY_CID.get(cid);
  if (!baseUrl) return undefined;
  return `${joinDisplayMediaUrl(baseUrl, mediaPath)}${match[3] || ''}`;
}

export function isKnownCdnUrl(url: string): boolean {
  return url.toLowerCase().startsWith(KNOWN_CDN_URL_PREFIX);
}

export function rewriteLegacyDisplayMediaUrl(url: string): string | undefined {
  if (!isLegacyDisplayMediaCandidate(url)) return undefined;
  return rewriteAssetsMonsDisplayMediaUrl(url) || rewriteIpfsDisplayMediaUrl(url);
}
