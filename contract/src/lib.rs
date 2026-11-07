//! KOL campaign escrow on NEAR.
//!
//! A project locks a fungible token (for example USDC) per KOL deal.
//! An off-chain agent checks the KOL's post on X and records a verdict.
//! The agent can only do three things: record a post, release to the KOL's
//! registered account, or refund the project. It can never send funds anywhere else.
//!
//! Two timeouts make it trustless in both directions:
//! - no post recorded by deadline + grace  -> anyone can refund the project
//! - post recorded, agent silent after hold + grace -> anyone can release to the KOL

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const SEC: u64 = 1_000_000_000;

pub type CampaignId = u64;
pub type DealId = u64;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Campaigns,
    Deals,
    DealsByKol,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum DealState {
    /// Funded, waiting for the KOL's post.
    Pending,
    /// Agent confirmed the post meets the terms. Hold window running.
    Posted,
    /// Paid to the KOL.
    Released,
    /// Returned to the project.
    Refunded,
    /// Transfer in flight (guards against double spend while waiting for the callback).
    Settling,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Verdict {
    pub action: String,
    pub reason: String,
    /// Hash or reference of the TEE attestation for the model call that produced the verdict.
    pub attestation: String,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Campaign {
    pub id: CampaignId,
    pub project: AccountId,
    pub token: AccountId,
    pub title: String,
    /// Text the post must contain, for example a hashtag or @mention.
    pub required_text: String,
    /// Latest time the post may go up (ns).
    pub deadline: U64,
    /// How long the post must stay up (seconds).
    pub hold_secs: U64,
    /// Funds received and not yet tied to a deal.
    pub unallocated: U128,
    pub deal_ids: Vec<DealId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub id: DealId,
    pub campaign_id: CampaignId,
    pub kol_handle: String,
    pub kol_account: AccountId,
    pub fee: U128,
    pub state: DealState,
    pub post_id: Option<String>,
    pub posted_at: Option<U64>,
    pub verdicts: Vec<Verdict>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    agent: AccountId,
    grace_secs: u64,
    next_campaign: CampaignId,
    next_deal: DealId,
    campaigns: IterableMap<CampaignId, Campaign>,
    deals: LookupMap<DealId, Deal>,
    deals_by_kol: LookupMap<AccountId, Vec<DealId>>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(agent: AccountId, grace_secs: U64) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            agent,
            grace_secs: grace_secs.0,
            next_campaign: 0,
            next_deal: 0,
            campaigns: IterableMap::new(Key::Campaigns),
            deals: LookupMap::new(Key::Deals),
            deals_by_kol: LookupMap::new(Key::DealsByKol),
        }
    }

    // ---------- project side ----------

    pub fn create_campaign(
        &mut self,
        token: AccountId,
        title: String,
        required_text: String,
        deadline: U64,
        hold_secs: U64,
    ) -> CampaignId {
        require!(deadline.0 > env::block_timestamp(), "Deadline must be in the future");
        require!(hold_secs.0 > 0, "Hold window must be above zero");
        require!(title.len() <= 120 && required_text.len() <= 120, "Text too long");
        let id = self.next_campaign;
        self.next_campaign += 1;
        self.campaigns.insert(
            id,
            Campaign {
                id,
                project: env::predecessor_account_id(),
                token,
                title,
                required_text,
                deadline,
                hold_secs,
                unallocated: U128(0),
                deal_ids: vec![],
            },
        );
        env::log_str(&format!("EVENT campaign_created {}", id));
        id
    }

    /// Ties part of the funded balance to one KOL. Once added, the project can't pull it back
    /// except through an agent refund or the no-post timeout.
    pub fn add_deal(
        &mut self,
        campaign_id: CampaignId,
        kol_handle: String,
        kol_account: AccountId,
        fee: U128,
    ) -> DealId {
        let mut c = self.campaign(campaign_id);
        require!(env::predecessor_account_id() == c.project, "Only the project");
        require!(env::block_timestamp() < c.deadline.0, "Campaign deadline has passed");
        require!(fee.0 > 0, "Fee must be above zero");
        require!(c.unallocated.0 >= fee.0, "Not enough unallocated funds");
        let handle = kol_handle.trim_start_matches('@').to_lowercase();
        require!(!handle.is_empty() && handle.len() <= 15, "Bad X handle");

        let id = self.next_deal;
        self.next_deal += 1;
        c.unallocated = U128(c.unallocated.0 - fee.0);
        c.deal_ids.push(id);
        self.campaigns.insert(campaign_id, c);

        self.deals.insert(
            id,
            Deal {
                id,
                campaign_id,
                kol_handle: handle,
                kol_account: kol_account.clone(),
                fee,
                state: DealState::Pending,
                post_id: None,
                posted_at: None,
                verdicts: vec![],
            },
        );
        let mut list = self.deals_by_kol.get(&kol_account).cloned().unwrap_or_default();
        list.push(id);
        self.deals_by_kol.insert(kol_account, list);
        env::log_str(&format!("EVENT deal_added {}", id));
        id
    }

    /// Returns funds that were sent in but never tied to a deal.
    pub fn withdraw_unallocated(&mut self, campaign_id: CampaignId) -> Promise {
        let mut c = self.campaign(campaign_id);
        require!(env::predecessor_account_id() == c.project, "Only the project");
        let amount = c.unallocated.0;
        require!(amount > 0, "Nothing to withdraw");
        c.unallocated = U128(0);
        let (token, project) = (c.token.clone(), c.project.clone());
        self.campaigns.insert(campaign_id, c);
        Self::ft_transfer(token, project, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_withdraw(campaign_id, U128(amount)),
        )
    }

    // ---------- agent side ----------

    /// Agent confirms the post exists, matches the terms and went up before the deadline.
    pub fn record_post(
        &mut self,
        deal_id: DealId,
        post_id: String,
        posted_at: U64,
        reason: String,
        attestation: String,
    ) {
        self.only_agent();
        let mut d = self.deal(deal_id);
        let c = self.campaign(d.campaign_id);
        require!(d.state == DealState::Pending, "Deal is not pending");
        require!(posted_at.0 <= c.deadline.0, "Post went up after the deadline");
        require!(posted_at.0 <= env::block_timestamp(), "Post time is in the future");
        require!(!post_id.is_empty() && post_id.len() <= 32, "Bad post id");
        d.post_id = Some(post_id);
        d.posted_at = Some(posted_at);
        d.state = DealState::Posted;
        push_verdict(&mut d, "post_verified", reason, attestation);
        self.deals.insert(deal_id, d);
        env::log_str(&format!("EVENT post_recorded {}", deal_id));
    }

    /// Agent confirms the post stayed up for the whole hold window. Pays the KOL.
    pub fn release(&mut self, deal_id: DealId, reason: String, attestation: String) -> Promise {
        self.only_agent();
        let d = self.deal(deal_id);
        require!(d.state == DealState::Posted, "Deal is not in the hold window");
        let c = self.campaign(d.campaign_id);
        let hold_end = d.posted_at.unwrap().0 + c.hold_secs.0 * SEC;
        require!(env::block_timestamp() >= hold_end, "Hold window has not ended");
        self.settle(d, c.token, true, "released", reason, attestation)
    }

    /// Agent found the terms were not met (deleted early, wrong content, botted, missed deadline).
    pub fn refund(&mut self, deal_id: DealId, reason: String, attestation: String) -> Promise {
        self.only_agent();
        let d = self.deal(deal_id);
        require!(
            d.state == DealState::Pending || d.state == DealState::Posted,
            "Deal is already settled"
        );
        let c = self.campaign(d.campaign_id);
        if d.state == DealState::Pending {
            // Without a recorded post, the agent can only refund after the deadline.
            // This stops a refund racing a KOL who is about to post.
            require!(env::block_timestamp() > c.deadline.0, "Deadline has not passed");
        }
        self.settle(d, c.token, false, "refunded", reason, attestation)
    }

    // ---------- timeouts anyone can trigger ----------

    /// No post was recorded and the deadline plus grace has passed: the project gets its money back.
    pub fn refund_expired(&mut self, deal_id: DealId) -> Promise {
        let d = self.deal(deal_id);
        require!(d.state == DealState::Pending, "Deal is not pending");
        let c = self.campaign(d.campaign_id);
        require!(
            env::block_timestamp() > c.deadline.0 + self.grace_secs * SEC,
            "Grace period has not ended"
        );
        self.settle(d, c.token, false, "refunded_timeout", "No post recorded by the deadline".into(), String::new())
    }

    /// The post was verified, the hold window ended, and the agent never gave a final verdict.
    /// The KOL gets paid. This stops a project from stalling payment by taking the agent offline.
    pub fn release_timeout(&mut self, deal_id: DealId) -> Promise {
        let d = self.deal(deal_id);
        require!(d.state == DealState::Posted, "Deal is not in the hold window");
        let c = self.campaign(d.campaign_id);
        let hold_end = d.posted_at.unwrap().0 + c.hold_secs.0 * SEC;
        require!(
            env::block_timestamp() > hold_end + self.grace_secs * SEC,
            "Grace period has not ended"
        );
        self.settle(d, c.token, true, "released_timeout", "Agent gave no final verdict in time".into(), String::new())
    }

    // ---------- funding ----------

    /// NEP-141 receiver. Send tokens with `ft_transfer_call` and msg `{"campaign_id": N}`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let parsed: FundMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("msg must be {\"campaign_id\": N}"));
        let mut c = self.campaign(parsed.campaign_id);
        require!(env::predecessor_account_id() == c.token, "Wrong token for this campaign");
        require!(sender_id == c.project, "Only the project can fund its campaign");
        c.unallocated = U128(c.unallocated.0 + amount.0);
        self.campaigns.insert(parsed.campaign_id, c);
        env::log_str(&format!("EVENT funded {} {}", parsed.campaign_id, amount.0));
        PromiseOrValue::Value(U128(0))
    }

    // ---------- callbacks ----------

    #[private]
    pub fn on_settle(
        &mut self,
        deal_id: DealId,
        to_kol: bool,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let mut d = self.deal(deal_id);
        if result.is_ok() {
            d.state = if to_kol { DealState::Released } else { DealState::Refunded };
            env::log_str(&format!("EVENT settled {} {}", deal_id, if to_kol { "kol" } else { "project" }));
        } else {
            // Transfer failed (for example the receiver has no storage on the token). Put it back.
            d.state = if d.posted_at.is_some() { DealState::Posted } else { DealState::Pending };
            d.verdicts.pop();
            env::log_str(&format!("EVENT settle_failed {}", deal_id));
        }
        self.deals.insert(deal_id, d);
        result.is_ok()
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        campaign_id: CampaignId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            let mut c = self.campaign(campaign_id);
            c.unallocated = U128(c.unallocated.0 + amount.0);
            self.campaigns.insert(campaign_id, c);
        }
        result.is_ok()
    }

    // ---------- views ----------

    pub fn get_config(&self) -> (AccountId, AccountId, U64) {
        (self.owner.clone(), self.agent.clone(), U64(self.grace_secs))
    }

    pub fn get_campaign(&self, campaign_id: CampaignId) -> Option<Campaign> {
        self.campaigns.get(&campaign_id).cloned()
    }

    pub fn list_campaigns(&self, from: u32, limit: u32) -> Vec<Campaign> {
        self.campaigns
            .values()
            .skip(from as usize)
            .take(limit.min(50) as usize)
            .cloned()
            .collect()
    }

    pub fn get_deal(&self, deal_id: DealId) -> Option<Deal> {
        self.deals.get(&deal_id).cloned()
    }

    pub fn get_campaign_deals(&self, campaign_id: CampaignId) -> Vec<Deal> {
        self.campaign(campaign_id)
            .deal_ids
            .iter()
            .filter_map(|id| self.deals.get(id).cloned())
            .collect()
    }

    pub fn get_kol_deals(&self, kol_account: AccountId) -> Vec<Deal> {
        self.deals_by_kol
            .get(&kol_account)
            .map(|ids| ids.iter().filter_map(|id| self.deals.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    // ---------- owner ----------

    /// Rotate the agent account (for example if its key leaks). Owner only.
    pub fn set_agent(&mut self, agent: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner");
        self.agent = agent;
    }
}

#[near(serializers = [json])]
struct FundMsg {
    campaign_id: CampaignId,
}

fn push_verdict(d: &mut Deal, action: &str, reason: String, attestation: String) {
    require!(reason.len() <= 500 && attestation.len() <= 400, "Verdict text too long");
    d.verdicts.push(Verdict {
        action: action.to_string(),
        reason,
        attestation,
        at: U64(env::block_timestamp()),
    });
}

impl Contract {
    fn only_agent(&self) {
        require!(env::predecessor_account_id() == self.agent, "Only the agent");
    }

    fn campaign(&self, id: CampaignId) -> Campaign {
        self.campaigns.get(&id).cloned().unwrap_or_else(|| env::panic_str("No such campaign"))
    }

    fn deal(&self, id: DealId) -> Deal {
        self.deals.get(&id).cloned().unwrap_or_else(|| env::panic_str("No such deal"))
    }

    fn settle(
        &mut self,
        mut d: Deal,
        token: AccountId,
        to_kol: bool,
        action: &str,
        reason: String,
        attestation: String,
    ) -> Promise {
        let receiver = if to_kol {
            d.kol_account.clone()
        } else {
            self.campaign(d.campaign_id).project
        };
        push_verdict(&mut d, action, reason, attestation);
        d.state = DealState::Settling;
        let (id, fee) = (d.id, d.fee.0);
        self.deals.insert(id, d);
        Self::ft_transfer(token, receiver, fee).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_settle(id, to_kol),
        )
    }

    fn ft_transfer(token: AccountId, receiver: AccountId, amount: u128) -> Promise {
        Promise::new(token).function_call(
            "ft_transfer".to_string(),
            near_sdk::serde_json::json!({ "receiver_id": receiver, "amount": U128(amount) })
                .to_string()
                .into_bytes(),
            ONE_YOCTO,
            GAS_FT_TRANSFER,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const DAY: u64 = 86_400 * SEC;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("escrow.near"))
            .predecessor_account_id(acc(pred))
            .block_timestamp(ts)
            .build());
    }

    /// Campaign 0, funded with 300, one deal of 100 for KOL alice.
    fn setup() -> Contract {
        ctx("owner.near", 0);
        let mut c = Contract::new(acc("agent.near"), U64(86_400));
        ctx("project.near", 0);
        let id = c.create_campaign(acc("usdc.near"), "Launch".into(), "#Launch".into(), U64(3 * DAY), U64(7 * 86_400));
        ctx("usdc.near", 0);
        c.ft_on_transfer(acc("project.near"), U128(300), format!("{{\"campaign_id\": {}}}", id));
        ctx("project.near", 0);
        c.add_deal(id, "@Alice".into(), acc("alice.near"), U128(100));
        c
    }

    #[test]
    fn funding_and_deal() {
        let c = setup();
        let camp = c.get_campaign(0).unwrap();
        assert_eq!(camp.unallocated.0, 200);
        let d = c.get_deal(0).unwrap();
        assert_eq!(d.kol_handle, "alice");
        assert_eq!(d.state, DealState::Pending);
        assert_eq!(c.get_kol_deals(acc("alice.near")).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Only the project can fund")]
    fn stranger_cannot_fund() {
        let mut c = setup();
        ctx("usdc.near", 0);
        c.ft_on_transfer(acc("mallory.near"), U128(1), "{\"campaign_id\": 0}".into());
    }

    #[test]
    #[should_panic(expected = "Wrong token")]
    fn wrong_token_rejected() {
        let mut c = setup();
        ctx("fake.near", 0);
        c.ft_on_transfer(acc("project.near"), U128(1), "{\"campaign_id\": 0}".into());
    }

    #[test]
    #[should_panic(expected = "Not enough unallocated")]
    fn cannot_overallocate() {
        let mut c = setup();
        ctx("project.near", 0);
        c.add_deal(0, "bob".into(), acc("bob.near"), U128(201));
    }

    #[test]
    fn happy_path_release() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1850000000000000000".into(), U64(DAY), "Post has #Launch".into(), "att1".into());
        assert_eq!(c.get_deal(0).unwrap().state, DealState::Posted);
        ctx("agent.near", DAY + 7 * DAY);
        c.release(0, "Still live after 7 days".into(), "att2".into());
        let d = c.get_deal(0).unwrap();
        assert_eq!(d.state, DealState::Settling);
        assert_eq!(d.verdicts.len(), 2);
        assert_eq!(d.verdicts[1].action, "released");
    }

    #[test]
    #[should_panic(expected = "Hold window has not ended")]
    fn cannot_release_early() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        ctx("agent.near", DAY + 6 * DAY);
        c.release(0, "early".into(), "".into());
    }

    #[test]
    fn deleted_early_gets_refunded() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        ctx("agent.near", 3 * DAY);
        c.refund(0, "Post deleted on day 2".into(), "att".into());
        assert_eq!(c.get_deal(0).unwrap().verdicts[1].action, "refunded");
    }

    #[test]
    #[should_panic(expected = "Only the agent")]
    fn project_cannot_refund_itself() {
        let mut c = setup();
        ctx("project.near", 5 * DAY);
        c.refund(0, "I changed my mind".into(), "".into());
    }

    #[test]
    #[should_panic(expected = "Deadline has not passed")]
    fn agent_cannot_refund_before_deadline_without_post() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.refund(0, "no post yet".into(), "".into());
    }

    #[test]
    #[should_panic(expected = "Post went up after the deadline")]
    fn late_post_rejected() {
        let mut c = setup();
        ctx("agent.near", 4 * DAY);
        c.record_post(0, "1".into(), U64(3 * DAY + 1), "late".into(), "".into());
    }

    #[test]
    fn kol_paid_if_agent_goes_silent() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        // hold ends day 8, grace 1 day -> day 9
        ctx("alice.near", 9 * DAY + 1);
        c.release_timeout(0);
        assert_eq!(c.get_deal(0).unwrap().verdicts[1].action, "released_timeout");
    }

    #[test]
    #[should_panic(expected = "Grace period has not ended")]
    fn release_timeout_waits_for_grace() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        ctx("alice.near", 8 * DAY + 1);
        c.release_timeout(0);
    }

    #[test]
    fn project_refunded_if_no_post() {
        let mut c = setup();
        ctx("project.near", 4 * DAY + 1);
        c.refund_expired(0);
        assert_eq!(c.get_deal(0).unwrap().verdicts[0].action, "refunded_timeout");
    }

    #[test]
    #[should_panic(expected = "Deal is not in the hold window")]
    fn no_double_settle() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        ctx("agent.near", 8 * DAY);
        c.release(0, "ok".into(), "".into());
        c.release(0, "again".into(), "".into());
    }

    #[test]
    fn failed_transfer_rolls_back() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        ctx("agent.near", 8 * DAY);
        c.release(0, "ok".into(), "".into());
        ctx("escrow.near", 8 * DAY);
        let ok = c.on_settle(0, true, Err(PromiseError::Failed));
        assert!(!ok);
        let d = c.get_deal(0).unwrap();
        assert_eq!(d.state, DealState::Posted);
        assert_eq!(d.verdicts.len(), 1);
    }

    #[test]
    fn successful_transfer_finalizes() {
        let mut c = setup();
        ctx("agent.near", DAY);
        c.record_post(0, "1".into(), U64(DAY), "ok".into(), "".into());
        ctx("agent.near", 8 * DAY);
        c.release(0, "ok".into(), "".into());
        ctx("escrow.near", 8 * DAY);
        assert!(c.on_settle(0, true, Ok(())));
        assert_eq!(c.get_deal(0).unwrap().state, DealState::Released);
    }
}
